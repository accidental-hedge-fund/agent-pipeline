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

## All-integrated milestone ship (#1252)

`pipeline ship --milestone vX.Y.Z` (and `pipeline train --milestone vX.Y.Z --merge`)
freeze **open non-backlog** issues **and** closed issues labeled
`pipeline:ready-to-deploy`. An all-integrated milestone (every freeze-eligible
issue closed at ready-to-deploy, linked PRs merged and contained in the fetched
base) does **not** stop at `no open issues to freeze`. Train merge-mode records
each item `already-integrated` and the ship run proceeds to the FRG / release
phase. Mixed milestones merge the still-open ready-to-deploy PRs and skip the
already-integrated set in the same run. Freeze does not invent a second
integrated classifier; a closed ready-to-deploy issue without a merged contained
PR still hits train merge-mode fail-closed law.

A missing FRG pass is **not** recovered by `--skip-frg` on a non-claude profile.
Run the pack on a native-`/goal` engine, then score it:

```bash
pipeline loop --label factory-gate --profile claude
pipeline factory-gate --for <X.Y.Z> --from-run <loop-run-id>
```

`--skip-frg` remains an operator escape that writes a non-production `no-frg-*`
pin. It is not the default and is not the implied path when the active profile
lacks native `/goal`.

FRG **never** merges PRs, enables auto-merge, or creates git tags (golden rule #4).
After a **release-eligible** pass, FRG **auto-closes** synthetic pack open PRs and
linked open issues **without merging** as post-pass hygiene (#754). Close ≠ merge.
When `.agent-pipeline/frg/` is gitignored, ship-end `pipeline release ensure-tag`
owns `vX.Y.Z` from on-disk HMAC `latest.json`. Auto-tag must not stall the ship
for a missing tree file.

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

Fields: `version`, `tag` (for `npx …#vX.Y.Z install`), `frg_run_id`,
`frg_evidence_path`, optional `git_sha` (null/unknown is valid — never invent a
SHA), `promoted_at`, optional `previous` for rollback.

A **production-quality** pin after an FRG ship has a real `frg_run_id` (not
`no-frg-*`) and a non-null `frg_evidence_path` for that version. Default
`pipeline factory-pin promote` and `pipeline engine-promote` refuse missing FRG,
`pass: false`, a `no-frg-*` run id, or a null evidence path. `--skip-frg` (or
`skip_frg: true`) is an explicit escape only: it writes `frg_run_id`
`no-frg-<X.Y.Z>` and `frg_evidence_path` null. That marker is not
production-quality. `pipeline factory-pin promote` has no skip and stays FRG-only.

On the live factory control checkout (factory-plane `REPO_DIR` /
`AGENT_PIPELINE_FACTORY_CONTROL`, or a managed worktree of that root — not
GitHub owner/name), `pipeline doctor` check `install:engine-track` fails when
the live pin is `no-frg-*` or has null evidence under pinned intent. Remediate
with a non-skip promote from a real FRG pass. A non-control clone of
`accidental-hedge-fund/agent-pipeline` leaves two-track policy inactive; a
leftover clone pin is not factory law. Host skill boot does not require
`AGENT_PIPELINE_PRODUCTION_PIN`.

The factory plane has one live pin file:
`$REPO_DIR/.agent-pipeline/production-engine-pin.json`. Do not default
`AGENT_PIPELINE_PRODUCTION_PIN` to
`~/.local/state/hermes-factory/production-engine-pin.json`. That Hermes-state
file is not live pin authority. `pipeline doctor` check
`install:production-pin-path` **fails** (not warn) when that env points
at a different file whose `version` or `git_sha` disagrees with the
control-checkout pin. v1.40.1 packaging MAY template supervisor env and
MUST NOT reintroduce a second live pin path.

| Action | Command |
|--------|---------|
| Show pin | `pipeline factory-pin show` |
| Bootstrap from FRG pass | `pipeline factory-pin init --from-frg <X.Y.Z>` |
| Promote after FRG pass | `pipeline factory-pin promote --for <X.Y.Z> [--git-sha <sha>]` |
| Optional promote after gate | `pipeline factory-gate --for <X.Y.Z> --from-run <id> --promote-pin-on-pass` |
| Rollback | `pipeline factory-pin rollback` (uses `previous`) or `… rollback --to <X.Y.Z>` |
| Verify | `pipeline doctor` → checks `install:engine-track` and `install:production-pin-path` |

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

### Durable hybrid v2 (current policy)

The current CLI has no safe production switch for controlled process death, forge 5xx,
CI red-to-green, stale pull-request creation, or forced recoverable outcomes. Do not add
an unsafe public injection switch only to green FRG.

`factory-gate-v1` uses **durable hybrid v2** (`factory-gate-v1-hybrid-v2`). The
policy is not pinned to one SemVer. Proof binds to the pack id, manifest hash,
**this candidate SHA**, the loop run, and the closed probe list.

From-run collect (#1298) sets `pack_provenance.candidate_git_sha` to the packed
candidate OID `C` from the scored loop's `factory-release-binding.json` and,
when the in-process scorer holds the request, `integrated_candidate.git_sha`.
Those values are exact 40-hex OIDs. When both are in hand they must be equal.
A request-bound ship-path score (request SHA provided, or binding file present)
fails closed before Layer A probes when the binding is missing, a present
source is malformed, or the two OIDs conflict. It does **not** call
`git rev-parse HEAD` of the factory control checkout `repoDir` for identity,
and it does **not** fall back to control HEAD. Standalone `--from-run` with no
request object and no binding file may still use `repoDir` HEAD. Layer A
probes run with cwd at the resolved candidate engine for `C`. Fast-forwarding
the operator control checkout is not the product fix. `--skip-frg` is not the
product fix.

Two disjoint proof sets. Every required scenario and composition id has exactly
one owner.

**Required-live / ledger / derived** — must be observed on the **candidate** pack
loop:

- `clean-item-throughput`
- `blocker-taxonomy`
- `empty-depends-on-stack-honesty`
- `openspec-bearing-item` (composition)

`not_observed` fails **required-live only**. Valid Layer A TAP hashes cannot make
unobserved required-live evidence release-eligible.

**Layer A-allowed** — closed hermetic probes hashed to **this candidate SHA**.
Named scenario set: `capacity-blocked-retain`, `resume-mid-flight`,
`openspec-multi-change`, `implement-lockfile-dirt`, `local-docs-parity`,
`pr-supersession`, `release-plan-row` (including the auto-tag guard probe).
Remaining required composition dimensions already mapped on that matrix stay
Layer A-allowed. The set does not grow without a later spec change.

- Each Layer A probe must run its exact named test on the same clean candidate
  commit. It must pass, must not skip, and must retain a hash of the actual TAP
  output bound to that SHA.
- Missing, skipped, failed, other-commit, dirty-checkout, or unreadable TAP
  fails that probe and overall pass.
- An id that is not on the closed set, including any required-live id, cannot
  use source `layer_a`.
- Evidence must label each proof as `live`, `ledger`, `derived`, or `layer_a`.
- A Layer A probe is not a live fault injection. Reports must not describe it as
  one.
- The runner accepts no caller-written pass, status, metric, or evidence receipt.

Later releases still generate FRG through the durable engine command:

```text
pipeline factory-release prepare --request "$TMPDIR/factory-release-prepare-request.json" --json
```

`--request` MUST be an absolute path outside the target checkout (`$TMPDIR`,
`AGENT_PIPELINE_STATE_HOME`, or the Tugboat `$RUN_DIR`). An in-checkout path
dirties protected `main` and fails doctor `worktree-clean` on the pack loop.
Tugboat already writes `$RUN_DIR/factory-release-prepare-request.json`.

This is an idempotent multi-tick protocol.

1. First call with no request-bound pack loop **starts** a `factory-gate`
   candidate pack loop (`pipeline loop --engine-track candidate`, work-list or
   `--label factory-gate`) from `frg-packs/factory-gate-v1/templates/`, writes
   `factory-release-binding.json` (request fingerprint, candidate SHA, version,
   manifest), persists `loop_run_id`, and returns `status: "in_progress"`.
   A re-invoke of the **unchanged** request **resumes** the same `loop_run_id`.
   It does **not** start a second unbound pack and does **not** adopt the newest
   unbound `factory-gate` loop. A missing pre-bound loop is a start/resume
   signal, not `missing_generator` / `pack_loop_missing`.
2. When the bound loop is terminal, prepare scores it with
   `pipeline factory-gate --for <version> --from-run <loop_run_id>` (or the
   in-process equivalent). It does **not** pass `--observations`. Hybrid v2
   scoring applies: required-live from the candidate pack loop; Layer A TAP
   hashes bound to the request packed candidate (loop
   `factory-release-binding.json` `candidate_git_sha` and, when in hand,
   request `integrated_candidate.git_sha`), not control-checkout HEAD.
   Request-bound collect must not fall back to `repoDir` HEAD. Fast-forwarding
   `REPO_DIR` is not the fix. `--skip-frg` is not the fix. HMAC `latest.json`
   is still written under the control checkout
   `.agent-pipeline/frg/<version>/`. Release-eligible
   `.agent-pipeline/frg/<version>/latest.json` with `pass: true` is written
   only on a genuine scorer pass with HMAC. Unsigned evidence MAY stay
   `pass: false` when HMAC is omitted; that is attestor input, not pack-fail.
   Real ineligible scores stay `pass: false` and `frg_not_eligible`.
3. After unsigned artifacts exist and no verified production-owned attestation
   exists, the call returns `awaiting_frg_attestation` with unsigned artifact
   identities and digests (`frg_run_id` **A**). It does **not** open a release PR.
   Checkpoint state is stored under
   `.agent-pipeline/factory-release/<request-fingerprint>/checkpoint.json`
   (keyed by repository, version, candidate commit, and action identity). The
   wrapper submits those closed artifacts to the fixed trusted attestor via
   credentialed `pipeline factory-gate --for <X.Y.Z> --from-run <loop>`. That
   attestor writes HMAC `latest.json` with a distinct attested `run_id` **B**
   and top-level `factory_release_binding` that names **A** and the closed
   unsigned digests **before** HMAC. Unsigned prepare and ship do not overlay
   that field after sign. A later prepare call uses the **unchanged** request,
   accepts HMAC-pass **B** when the binding matches **A**, invokes shared
   `runRelease` (prepare-only), and returns `complete` with the attested run
   identity. Repeated calls must reconcile the same checkpoint without another
   pack, attestation, branch, or pull request. Production identities stay
   distinct (`A` vs `B`). Composers invoke the attestor **once** per unchanged
   complete checkpoint binding, then fail closed on absent or rejected observe.

Prepare never merges, tags, promotes a pin, or flips Tugboat `--skip-frg`.

### Post-1.33 honest-pass precondition (skip-frg restore)

#1038 landed `isHonestPost133FrgPass` and one accepted post-1.33
`latest.json` `pass: true`. That helper remains the single skip-frg restore
predicate. #1039 consumed it: Tugboat default release and promote argv now
**omit** `--skip-frg`, and Tugboat runs one FRG pack phase
after train and before release. #1133: that pack invokes
`pipeline factory-release prepare` with attestor env **unset** in the
prepare child. When prepare returns `awaiting_frg_attestation`, the
composer runs `pipeline factory-gate --for <X.Y.Z> --from-run <loop>` in a
**separate** credentialed process (no `--observations`) **once** for that
unchanged unsigned checkpoint. That child writes HMAC `factory_release_binding`
joining attested `run_id` **B** to unsigned **A** before sign. Pack-done is
prepare `complete` after accepted observe of that bound **B**, or bound
`latest.json` `pass: true`. Unsigned `awaiting_frg_attestation` is **not**
pack-done. A second attestor spawn for unchanged **A** is forbidden.
Unsigned eligible omitted-HMAC `pass: false` is **attest**, not pack-fail.
Ship-path composers wait until the bound pack loop is terminal (or a real
pack-fail). Wait-budget expiry while that loop is live is **not** pack-fail.
Auto-tag (#1040) and pin (#1041) remain later children. They do not invent
a second pass definition.

The check accepts only a genuine `factory-gate --for <version> --from-run
<loop_run_id>` score (or the in-process equivalent) of a request-bound
`factory-gate-v1` **candidate** pack. It requires `pass: true`, a non-empty
`run_id` / `loop_run_id`, pack identity `factory-gate-v1`, and
`pack_provenance.candidate_git_sha`. Required-live ids
(`clean-item-throughput`, `blocker-taxonomy`,
`empty-depends-on-stack-honesty`, `openspec-bearing-item`) must not be
`not_observed`. Layer A-allowed ids must cite TAP hashes bound to that
same candidate SHA.

The check requires runner-stamped `score_source: from-run` and
`work_list: factory-gate-pack` on the evidence object. Notes and caller
options cannot establish those fields. Persist does not stamp those
fields from caller options. The check also requires a runner-issued
HMAC-SHA256 `integrity.score_receipt` under `PIPELINE_FRG_ATTESTATION_KEY`
that binds the computed `pass` to the run. A hand-edited `pass: true`
or a reminted public hash of the same fields is not proof.

The check **refuses**:

- a `1.33.0`-only (or earlier) artifact
- `pass: false` (persist never rewrites a fail score to `pass: true`)
- the product v1.39 milestone work-list, `work_list: other`, or a missing work-list
- a caller-authored `--observations` file, or missing `score_source: from-run`
- required-live `not_observed`
- an unknown `layer_a` id or a TAP bound to another commit

Full HMAC attestation (`integrity.attestation`) is **not** required for
this precondition. The score receipt still requires the producer key.
A fail score stays `pass: false` and does not put `--skip-frg` back on
Tugboat default argv. The operator escape with a logged reason is the only
skip path.

**Hard gate:** missing, stale, failed, mismatched, skipped, or waived
required-live evidence, or a missing/mismatched Layer A TAP hash, yields
non-zero exit / non-`complete` status and blocks release preparation. Synthetic
trivial docs/fixture packs are **not** release-eligible. Hybrid v1
(`factory-gate-v1-hybrid-v1` pinned to `1.33.0`) cannot satisfy a later version.

### Historical note: v1.33.0 hybrid v1

v1.33.0 evidence bound to `factory-gate-v1-hybrid-v1` remains historically valid
for that version only. The 1.33.0 runner used the same required-live vs closed
Layer A split, but the policy identity and release pin expired after that
version. Do not reuse the v1 policy id, a 1.33.0-only release pin, or a 1.33.0
candidate artifact for a later version.

Request JSON (`schema_version: 1`, `kind: "factory_release_prepare_request"`)
binds at least: `action_id`, `repository`, `base_branch`, `target_version`,
`integrated_candidate.git_sha`, `frg_manifest.{pack_id,sha256}`. Optional:
`grant_fingerprint`, `milestone`, `ordered_merges`, `production_pin`,
fingerprints. Forbidden: credentials, executable paths, modules, network
targets, and caller-authored `pass` / status / metric / receipt claims.

The two-release integration test must start from the verified v1.33.0 pin,
prepare and install v1.34.0 through the candidate interface, and prove that the next grant
uses v1.34.0 without a wrapper or config replacement.

### Factory attestation boundary

The factory does not place the FRG key or its path in the candidate
environment, inherited file descriptors, the candidate-action cgroup's
credential mount, a request, a result, an error, a log, or a notice. The
existing scorer unit runs only a fixed wrapper-local trusted attestor. It starts
no child process, uses no network, and does not import or execute candidate code
or other request-selected code.

The request contains only versioned identity fields, closed data paths under
fixed allowed roots, and expected digests. It contains no executable path,
module, command, network target, pass claim, or candidate-selected signer. The
attestor independently reads the evidence, verifies the digests, computes the
policy result, and returns only the bounded attestation.

For v1.33.0, the scorer uses the policy snapshot pinned with #898. For later
releases, it uses the signer from the verified current production engine. It
stops if the request schema, evidence schema, signer, or policy is unsupported.
It never imports a signer from candidate code. Tests must prove no automatic
key or key-path propagation through the candidate environment, inherited file
descriptors, candidate-action cgroup credential mount, request, or result; no
candidate import or execution by the attestor; request-selected import and
network denial; and secret redaction in errors, logs, and notices.

The pilot accepts that `mcomardo` and passwordless sudo have broad local
authority. A malicious same-user process can read or control local resources.
These process controls do not provide privilege separation. Issues #618, #899,
or later hardening own that boundary.

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
  `auto-tag-release.yml`). Engine HMAC-verify (`factory-gate --from-run` and
  `release ensure-tag`) and in-engine `pipeline ship` attestor / ensure-tag children
  present `PIPELINE_FRG_ATTESTATION_KEY_FILE` as `PIPELINE_FRG_ATTESTATION_KEY`
  using one recipe: inherit `KEY` and unset `KEY_FILE`; else fail closed on
  missing, empty, or unreadable `KEY_FILE` (`missing_attestor_credential` /
  `unreadable_attestor_key_file`); else set `KEY` from the file body and unset
  `KEY_FILE`. HMAC mint and verify still authenticate with `KEY` after
  presentation. Hosts keep a file; the engine loads it. A Tugboat wrap is not
  required. Tugboat may keep the same recipe as defense in depth. GitHub Actions
  auto-tag still uses repo secret `KEY`.
- Direct trusted operator use may export the key before `pipeline factory-gate …` so
  `integrity.attestation` is written. A release candidate must never use this path;
  its fixed scorer unit owns attestation.
- Mint: trusted code writes the attestation (`alg: hmac-sha256-v1`, hex MAC over
  version/run_id/loop_run_id/pack_id + fingerprints).
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
`pipeline release` does **not** `git add` this gitignored tree (including `git add -f`).
Attachment is the release PR body `run_id` / pass summary. Evidence stays on disk.

**Ignore bar (#1127 / #1148):** `.agent-pipeline/frg/` **is** gitignored on the factory
control checkout (engine artifact contract). A pack or promote write of
`latest.json` must not fail the next train's `worktree-clean` check. Do **not**
commit leftover `latest.json` onto the protected checkout. Host-only
`git update-index --skip-worktree` is not the product fix.

Local `latest.json` remains the ship-host lookup for `pipeline release`,
`pipeline engine-promote`, and `pipeline release ensure-tag` on the host that
just packed. Auto-tag must not block the ship when that path is gitignored.
Local `release ensure-tag` creates `vX.Y.Z` from on-disk HMAC evidence.
Release MAY still attach that version's evidence onto the **release PR**, but
attachment is the PR-body `run_id` (not a committed tree). Attachment is not
required for auto-tag or for local ensure-tag. That is not a reason to leave
`frg/` unignored on the factory control checkout.

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
# Hosts keep a file; the engine presents KEY_FILE as KEY. Inline KEY also works.
export PIPELINE_FRG_ATTESTATION_KEY_FILE=/path/to/frg-attestation-key
# export PIPELINE_FRG_ATTESTATION_KEY='…'   # same value as the repo Actions secret
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
- **GitHub ready-to-deploy overlay (#1297):** `--from-run` (and prepare, which scores
  through that path) counts a pack item as clean-ready when live GitHub shows
  `pipeline:ready-to-deploy` and the **bound** PR checks are green, even if the
  durable ledger still says `blocked` with `stop.reason=recovery_exhausted`.
  Operators do not delete `ledger.stop` to score throughput. Missing GitHub,
  an unbound PR, pending/failed checks, and `needs-human` without R2D stay
  not clean-ready. `startLoop` scoring stays ledger-only.
- **Observation required:** overall `pass: true` requires every **required-live**
  scenario (`clean-item-throughput`, `blocker-taxonomy`,
  `empty-depends-on-stack-honesty`) and the OpenSpec-bearing composition item to
  be observed with machine-checked criteria. `not_observed` fails required-live
  only. Layer A-allowed ids may prove from a same-candidate TAP hash. `fail` or
  `skip` still fails the gate for every required id. `capacity-blocked-retain`
  pass requires `observed ≥ N` (`capacity_stress_n`). `warn` is pass-permitting
  only for documented honesty outcomes (e.g. `empty-depends-on-stack-honesty`).
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

6. Keep on-disk HMAC `.agent-pipeline/frg/<X.Y.Z>/latest.json` on the ship host
   for `pipeline release ensure-tag`. Attachment to the release PR is optional.
   Do not leave `frg/` unignored on the factory control checkout.

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
   Does **not** `git add` `.agent-pipeline/frg/` (that tree is gitignored). Evidence stays
   on disk. The release commit is version / ROADMAP / generated packaging files only.
5. Still runs `npm run ci` (additive). FRG, open-soak preflight, and CI are independent.
6. Does **not** merge or tag because FRG/open-soak passed.
7. If `git add` or `git commit` fails after `git checkout -b release/vX.Y.Z`, restores the
   configured base (`base_branch`, default `main`), restores release-managed files from
   HEAD, and deletes the local release branch when it has no unique commit. On-disk FRG
   files remain. A successful commit is the point of no return (push failure stays on
   the branch).

### Auto-tag FRG guard (#757 / #1040 / #1149)

On a detected release merge (`release: X.Y.Z — …` subject + `core/package.json` version match,
tag not already present), `.github/workflows/auto-tag-release.yml`:

1. If `.agent-pipeline/frg/<X.Y.Z>/latest.json` is **absent and gitignored**,
   exits 0 without creating a tag. Local `pipeline release ensure-tag` owns
   `vX.Y.Z` from on-disk HMAC evidence.
2. If that tree file **exists**, verifies it via the shared Node validator
   (`factory-reliability-gate.ts --validate-tag <version>`), even when the path
   is gitignored.
3. **Fails closed** (no tag create/push) when the tree file is missing and not
   ignored, or exists but is unparsable, `pass: false`, or not release-eligible.
   The fail-closed message names `.agent-pipeline/frg/<X.Y.Z>/latest.json` and
   names `factory-release prepare` / the Tugboat FRG pack phase as the
   remediation. FRG is not optional or advisory on the local tag path.
4. On validation success, proceeds to notes resolution and annotated tag push
   (existing rules).
5. Non-release pushes remain successful no-ops without FRG.
6. Existing tags remain successful no-ops.

FRG never creates tags itself. When FRG is gitignored, ship-end
`pipeline release ensure-tag` is the tag owner. Auto-tag must not stall the
ship for a missing tree file.

Remediation when the **local** tag helper fail-closes:

```bash
pipeline factory-release prepare --request "$TMPDIR/factory-release-prepare-request.json" --json
```

Or re-run the Tugboat FRG pack phase so on-disk
`.agent-pipeline/frg/<X.Y.Z>/latest.json` is a release-eligible `pass: true`
artifact. Then retry `pipeline release ensure-tag`. Do not commit `latest.json`
onto the factory control checkout.

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
- [ ] On-disk HMAC `.agent-pipeline/frg/<version>/latest.json` present on the
      ship host for `pipeline release ensure-tag` (attachment optional; do not
      un-ignore `frg/` on the factory control checkout)
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
