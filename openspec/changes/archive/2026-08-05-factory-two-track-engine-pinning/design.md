## Context

Factory self-hosting today has the pieces for pinning but not the **two-track policy**:

| Piece | Exists today | Gap |
| --- | --- | --- |
| Tag-pinned install | `npx …#vX.Y.Z install` (README) | Not the mandatory factory production policy; operators can still run from working tree / floating default branch |
| FRG pass artifact | `.agent-pipeline/frg/<X.Y.Z>/latest.json` via `lookupFrgPass` | Pass does not promote a production pin; release refuses without FRG, but dogfood still may run the candidate |
| Doctor version coherence | `install:version-coherence` (loaded VERSION vs on-disk) | No track (`pinned` vs `candidate`) and no pin-target comparison |
| Doctor freshness | `install:version-freshness` vs latest GitHub release tag | Report-only; does not encode "intentionally pinned last-FRG-passed" |
| Run engine identity | `run.json` `engine.{version,root,templates_fingerprint}` + mid-run drift (#450) | No `track` field; cannot attribute defects to pin vs candidate |

v1.29.0 soak proved the feedback loop: candidate regressions degrade the repair capacity of the
same process that must fix them. Reliability audit (2026-07-31) named two-track stabilization as
the gap.

Constraints:

- Golden rule #4: no auto-merge / unattended release authority.
- FRG pack composition is out of scope (sibling issues); this change **consumes** FRG pass artifacts.
- A pin **bundled only inside a released skill install** cannot be the live factory pin: after
  `npx …#vX.Y.Z install`, that tree is frozen until reinstall, so promote/rollback would be
  impossible without a new tag. The live pin must live **outside** the install package.
- Prefer existing seams: doctor `DoctorDeps`, run-store written-once engine identity,
  `lookupFrgPass` / `normalizeFrgVersion`, FRG evidence under `.agent-pipeline/frg/`,
  atomic tmp+rename writes (FRG evidence, evidence-bundle).

## Goals / Non-Goals

**Goals:**

1. Define two tracks: **pinned** (last FRG-passed release promoted into dogfood) and **candidate**
   (unreleased / working-tree / release-branch build).
2. Make an **external, resolvable production pin** the authoritative target for factory dogfood.
3. Enforce track selection via explicit CLI/config intent (not docs alone).
4. Promote the pin only from FRG `pass: true` for that version; document rollback by repoint + reinstall.
5. Disclose track + version (+ SHA only when resolvable) on doctor and in run evidence.
6. Bootstrap hosts with no pin from a verified prior FRG pass (same promotion gate, no bypass).
7. Unit-test pin resolution, track classification, doctor mismatch, promote refusal, and rollback
   without real I/O.

**Non-Goals:**

- FRG scenario-pack composition or threshold retuning.
- Auto-merge, auto-tag, or unattended release.
- Cross-host install locking beyond a repo-checked pin + reinstall procedure.
- Replacing mid-run template snapshot isolation or existing version-coherence/freshness checks.
- Forcing every non-factory consumer of the skill onto the pin (downstream repos may float;
  **factory** production policy is normative for this control repo).

## Decisions

### Decision 1 — Authoritative pin lives on the factory control checkout, not inside the install package

**Chosen:** The live production pin is a machine-readable JSON file on the **factory repo
checkout** (the agent-pipeline control repo being dogfooded), not the frozen skill install tree:

| Item | Value |
| --- | --- |
| Path | `<repoDir>/.agent-pipeline/production-engine-pin.json` |
| Constant | `PRODUCTION_ENGINE_PIN_REL = ".agent-pipeline/production-engine-pin.json"` (single-source; add to artifact contract as a **non-gitignored** file, same spirit as FRG evidence under `.agent-pipeline/frg/` which is intentionally commitable) |
| Ownership | Factory operators / promote+rollback helpers write it; hosts **read the same path** for doctor, run-start classification, and reinstall instructions |
| Optional override | Env `AGENT_PIPELINE_PRODUCTION_PIN` (absolute path) or config `production_engine_pin_path` for exotic layouts — default resolution is always repo-local |

**Schema (`schema_version: 1`):**

| Field | Required | Intent |
| --- | --- | --- |
| `schema_version` | yes | Integer; start at `1` |
| `version` | yes | Semver without requiring leading `v` (e.g. `1.29.1`); normalize with same rules as `normalizeFrgVersion` |
| `tag` | yes | Git release tag (e.g. `v1.29.1`) used for `npx …#<tag> install` |
| `git_sha` | no (nullable) | 40-char release commit when known; **null/omitted when not resolvable** — never invent |
| `git_sha_source` | no | `"operator" \| "promote-arg" \| "frg-note" \| "unknown"` — only claim attribution when source is known |
| `frg_run_id` | yes | Authorizing FRG evidence `run_id` (non-empty) |
| `frg_evidence_path` | no | Relative path of evidence used at promote (e.g. `.agent-pipeline/frg/1.30.0/latest.json`) |
| `promoted_at` | yes | ISO 8601 UTC from injected clock |
| `previous` | no | Full prior pin object (one level) for rollback reference |

**Rejected:** Pin only inside installed skill package under `docs/` of the install root
(frozen at install time → split-brain with live factory policy).  
**Rejected:** Env-var-only pin (not auditable; diverges silently).  
**Rejected:** Implicit "latest GitHub release" as pin (FRG pass is the gate).  
**Rejected:** Host-XDG-only pin as sole authority (factory multi-host needs a repo-visible
artifact; XDG may be used later as a cache but not as source of truth).

**Why.** Doctor, promote, and run evidence share one resolution function
`resolveProductionPin({ repoDir, readTextFile, overridePath? })`. Production invocation and
doctor both call it against the same `repoDir`, so they cannot disagree on which pin artifact
was read. Promote/rollback update the control-repo file without requiring a new engine tag that
embeds the pin. Operators reinstall the **skill** from `pin.tag`; the pin file itself lives on
the checkout.

### Decision 2 — Explicit track-selection interface (enforceable)

**Chosen:** Track intent is an explicit enum, never inferred only from prose:

```text
engine_track_intent: "pinned" | "candidate"
```

**Sources (highest wins):**

1. CLI flag: `--engine-track pinned|candidate` on advance / loop / doctor when applicable.
2. Config: `.github/pipeline.yml` key `engine_track` (optional).
3. **Command default:**
   - `pipeline factory-gate` and FRG Layer B driver paths → **candidate** (hard-coded; not overridable to `pinned` without an explicit escape that still records candidate soak evidence — implement as force-candidate for factory-gate).
   - `pipeline evals …` → **candidate**.
   - Ordinary `pipeline loop` / `single` / advance / default doctor → **pinned**.

**Enforcement at run start (pinned intent):**

- Resolve pin; resolve running engine version (`EngineIdentity.version` / VERSION).
- If pin missing/unreadable → refuse start (or doctor fail) with bootstrap remediation; do **not**
  label the run as coherent `pinned`.
- If `normalizeVersion(running) !== normalizeVersion(pin.version)` → refuse start with
  remediation: reinstall from `pin.tag` or re-invoke with `--engine-track candidate` for an
  intentional soak. Do **not** present the run as track `pinned`.
- If match → classify `pinned`, write evidence.

**Candidate intent:**

- Never fails solely for pin mismatch.
- Always records `engine.track = "candidate"`.
- Still reports pin target on doctor for contrast.

**Rejected:** Documentation-only policy (cannot prevent mislabeled production runs).  
**Rejected:** Inferring track solely from dirty git / worktree path.

### Decision 3 — Promotion contract (precise)

**Eligibility input:** existing `lookupFrgPass(repoDir, version, deps)` only.

| Case | Behavior |
| --- | --- |
| `kind: "pass"` and `evidence.version` matches normalized target and `evidence.run_id` non-empty and `evidence.pass === true` | Eligible |
| `kind: "fail"` (`pass: false`) | Refuse; no pin write |
| `kind: "missing"` | Refuse; no pin write |
| `kind: "unparsable"` | Refuse; no pin write |
| Version mismatch after normalize | Refuse; no pin write |

**Evidence path:** `.agent-pipeline/frg/<normalizedVersion>/latest.json` (see
`frgLatestPath` / `FRG_EVIDENCE_ROOT_REL`). Promote does **not** search alternate trees or pick
"newest among multiple run dirs" beyond what `latest.json` already points at.

**Promote algorithm (pure + injected I/O):**

1. `normalizeFrgVersion(target)`.
2. `lookupFrgPass(repoDir, target, frgDeps)`.
3. On non-pass → return structured refusal; **zero pin mutations**.
4. Load current pin if present → stash as `previous`.
5. Build new pin: version, tag (`v` + version), `frg_run_id = evidence.run_id`,
   `frg_evidence_path`, `promoted_at = now()`, `git_sha` only if provided via promote arg or
   already known on prior pin for same tag — **never fabricate from network inside promote unit
   path**; optional separate resolvable seam may supply SHA when caller injects it.
6. Atomic write: write `.tmp` sibling + `rename` (same pattern as `writeFrgEvidence` /
   evidence-bundle).
7. Print reinstall command: `npx -y github:accidental-hedge-fund/agent-pipeline#<tag> install …`
   — promote does not reinstall itself.
8. Never call merge, tag, or auto-merge seams.

**CLI surface:** `pipeline factory-pin promote --for <version>` (and optional
`--git-sha <sha>`). Optional `pipeline factory-gate --promote-pin-on-pass` remains **opt-in**
and only calls the same helper after a recorded pass.

**Seams:** `readFile` / `writeFile` / `rename` / `now` / `lookupFrgPass` injected; unit tests use
fakes only.

### Decision 4 — Pin identity / git_sha honesty

**Chosen:**

- `git_sha` is optional. Absence is valid and reported as `git_sha: null` /
  `sha_status: "unknown"`.
- Doctor and evidence **MUST NOT** claim a release SHA was verified unless the pin carries a
  non-empty `git_sha` from a documented source.
- When present, doctor reports `pin.git_sha` alongside versions; it does not network-resolve
  tags in the default hermetic path.
- Mid-run `engine_drift` continues to compare version + templates_fingerprint only (existing
  #450 path); it does not rewrite `engine.track` or invent SHA.

### Decision 5 — Track capture once at run creation; consumers do not rewrite history

**Writers of `run.json` engine identity today:**

- `initRunDir` in `run-store.ts` (written-once; existing idempotency guard).
- Populated by `pipeline-run.ts` via `resolveRunEngineIdentity` + `resolvePinnedEngineIdentity`.

**Chosen:**

- Extend `RunEngineIdentity` with:
  - `track?: "pinned" | "candidate"` (required for **new** runs that write engine identity;
    historical missing → treat as unknown).
  - `pin_version?: string`
  - `git_sha?: string` (optional)
- Classification + pin fields computed **only** in the fresh-resolve path at first
  `initRunDir` for a run-id.
- `resolveRunEngineIdentity` already reuses existing `run.json` engine on resume — do not
  reclassify or overwrite `track` on re-entry.
- Consumers (evidence bundle, scoreboard, summary, FRG scorers): if `engine.track` absent →
  `unknown`; never invent `pinned`/`candidate` from version alone.
- Mid-run drift: keep `engine_drift` events; do **not** mutate `run.json` `engine.track`.

### Decision 6 — Bootstrap / migration when pin is missing

**Chosen:** Explicit init path, same FRG gate as promote:

```text
pipeline factory-pin init --from-frg <version>
```

Rules:

1. Refuse if pin already exists unless `--force` (force still requires FRG pass for the named
   version — no "blank pin" force).
2. Require `lookupFrgPass` → `kind: "pass"` for that version.
3. Write pin with same schema as promote (`previous` null on first init).
4. Print reinstall instructions from `tag`.
5. Doctor missing-pin remediation names this command (and the pin path).

**Rejected:** Silent default to latest GitHub release.  
**Rejected:** Init without FRG pass (would bypass promote eligibility).

### Decision 7 — Doctor check is additive

**Chosen:** New check id `install:engine-track` in `buildPreflightChecks`, after
`install:version-coherence` / near freshness:

| Situation | Status |
| --- | --- |
| Pin match + pinned intent | `pass` — detail includes pin version + track `pinned` |
| Pin mismatch + pinned intent | `fail` — names both versions; remediation reinstall from tag or `--engine-track candidate` |
| Pin missing + pinned intent | `fail` — remediation: `factory-pin init --from-frg …` |
| Candidate intent (any pin/install relation) | `pass` or non-fail for mismatch; detail reports pin target + track `candidate` |
| Pin unreadable (I/O) | `fail` or `warn` with restore remediation — never silent omit |

Uses `DoctorDeps.readTextFile` + injected version/intent (extend check closure or thin pure
helper `evaluateEngineTrackCheck(...)` for unit tests). Does **not** replace coherence or
freshness.

### Decision 8 — Rollback contract

**Chosen:**

1. `pipeline factory-pin rollback` (default: restore `pin.previous` if present; or
   `--to <version>` requiring retained previous/history or FRG pass for target).
2. Atomic pin write only after validating the target pin snapshot schema.
3. If no valid prior pin / FRG pass for target → refuse; **active pin unchanged**.
4. Print reinstall from restored tag; operator reinstalls; doctor verifies match.
5. No force-push, no merge, no worktree wipe of product issues.

### Decision 9 — Prefer ADDED requirements; keep capability split

Unchanged from prior design: new capability owns policy; deltas on doctor, run-dir, FRG only
add hooks.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Split-brain: install package vs control pin | Single `resolveProductionPin(repoDir)`; doctor + run-start share it; tests assert same path/content |
| Operators still run candidate as dogfood | Pinned intent enforced at run start + doctor fail; candidate requires explicit intent |
| Pin file not committed → host divergence | Docs: commit pin after promote for multi-host; doctor per host reports install vs pin |
| SHA claimed without source | Nullable `git_sha` + explicit `git_sha_source`; no network invent in promote |
| Bootstrap bypass | init/promote both require FRG pass |
| Over-blocking non-factory doctor users | Default pinned intent is for this factory control repo; missing pin fail scoped to pinned intent; candidate intent does not require match |

## Migration Plan

1. Land pin module + path constant + artifact-contract entry (commitable file, not gitignored like runs/).
2. `factory-pin init --from-frg <current-last-pass>` on factory checkout (or seed first pin in-repo from known FRG pass at implement time).
3. Ship doctor check + run evidence `track` (additive).
4. Update FRG runbook + README two-track section.
5. Operators reinstall from pin tag; dogfood loops run with default pinned intent.
6. After next FRG pass: `factory-pin promote --for X.Y.Z`, reinstall, doctor pass.
7. Rollback drill once.

No historical run migration: missing `engine.track` → unknown.

## Open Questions (resolved by this revision)

1. **Pin path:** `.agent-pipeline/production-engine-pin.json` on **repoDir** (not install root).
2. **Strictness:** fail on mismatch/missing under **pinned** intent; candidate intent never fails for mismatch alone.
3. **Auto-write on FRG pass:** opt-in only (`--promote-pin-on-pass` or separate promote command).
4. **git_sha:** optional; unknown is valid.

## Implementation map (surgical)

| Area | Files / pattern |
| --- | --- |
| Pin module | New `core/scripts/production-engine-pin.ts` — load/validate/classify/promote/rollback/init; injected deps |
| Artifact contract | `artifact-ignore.ts` — register pin file as contract entry **without** adding it to the gitignore block if FRG-style commitable (or document as commitable path parallel to frg/) |
| Doctor | `stages/doctor.ts` `buildPreflightChecks` → `install:engine-track` |
| Run identity | `engine-identity.ts` / `run-store.ts` `RunEngineIdentity` + `pipeline-run.ts` fresh resolve |
| CLI | `pipeline.ts` + `command-registry.ts` — `factory-pin` subcommands; `--engine-track` on loop/advance/doctor |
| FRG | `factory-reliability-gate.ts` — force candidate track on Layer B; optional promote hook |
| Docs | `docs/factory-reliability-gate-runbook.md`, README, `docs/cli.md` |
| Tests | `core/test/production-engine-pin.test.ts`, doctor + run-store extensions |
| Mirror | `node scripts/build.mjs` after core changes |

## Pattern citations (must follow)

1. **Doctor preflight + `DoctorDeps`:** `core/scripts/stages/doctor.ts` —
   `buildPreflightChecks` pushes `{ id, description, run(deps) }`; install checks use
   `deps.readTextFile` / `deps.exec` only — mirror for `install:engine-track`.
2. **FRG lookup + atomic write:** `lookupFrgPass` / `writeFrgEvidence` in
   `factory-reliability-gate.ts` — promote eligibility and pin writes reuse this style
   (latest.json pointer; tmp+rename; injected `FrgFsDeps`-like seams).
3. **Written-once engine identity:** `resolveRunEngineIdentity` + `initRunDir` in
   `run-store.ts` / `pipeline-run.ts` (#450) — capture track once; resume reuses; drift is
   separate events.
