## Context

See `proposal.md` for why. Current law and code:

- Living spec `factory-reliability-gate` says hybrid Layer A is valid only for
  `1.33.0` and that later releases SHALL NOT use the hybrid rule.
- The same spec says any required scenario with status `not_observed` fails
  overall pass, including `pass: true` schema rejection.
- Code already has the 1.33 two-set matrix in
  `core/scripts/frg-packs/factory-gate-v1/manifest.json` (`live_scenario_ids`,
  `live_composition_ids`, `layer_a_probes`) and
  `core/scripts/frg-pack-observations.ts`
  (`FRG_HYBRID_LIVE_SCENARIO_IDS`, `FRG_HYBRID_LIVE_COMPOSITION_IDS`).
- `hybridPilotProofValid` returns false for every version other than
  `1.33.0` unless `pack_provenance` is null. The collector throws
  `FRG hybrid proof is valid only for release 1.33.0`.
- Policy constants are pinned:
  `FRG_HYBRID_PILOT_POLICY_ID = "factory-gate-v1-hybrid-v1"`,
  `FRG_HYBRID_PILOT_VERSION = "1.33.0"`,
  `FRG_HYBRID_REPLACEMENT_ISSUE = 908`.
- The runbook hybrid-expiry paragraph still refuses Layer A for any version
  other than exactly `1.33.0`.

**Conflict (do not average):** the living spec and runbook forbid post-1.33
hybrid. Issue #1036 requires durable hybrid v2 for later versions. This
change **replaces** the expiry. It does not keep a hidden 1.33-only gate.

**Class vs site (engine-dogfood bar):** this is a **class** fix to shared FRG
scoring / pack-manifest / collector law. The site symptom is “1.34+ cannot
honestly pass.” The class is: unsafe-to-inject pack scenarios cannot be
required-live, or the gate is permanently false. Shared surfaces that must
change: pack policy identity, collector version binding, scorer
`hybridPilotProofValid` / `isReleaseEligibleFrgPass` / `not_observed` rule,
runbook. After this lands, the next identical fault does **not** need a new
one-version mole issue.

## Goals / Non-Goals

**Goals:**

- Promote the existing 1.33 two-set matrix to durable hybrid v2, bound to the
  **current candidate SHA**, not to SemVer `1.33.0`.
- Make `not_observed` fail required-live only.
- Keep Layer A as a closed, runner-constructed TAP-hash proof. Refuse unknown
  `layer_a` ids and caller-authored pass claims.
- Keep v1.33.0 hybrid v1 historically valid for that version only.
- Bite the three unit cases named in the issue.

**Non-Goals (design-level):**

- New live fault-injection seams (process kill, forge 5xx).
- Starting a pack loop or minting release evidence in this change.
- Tugboat, `--skip-frg`, auto-tag, or production-pin changes.
- Fabricated `--observations` files or test-only all-pass overrides in
  production collection.
- Expanding or shrinking the Layer B scenario id inventory.
- Scoring a product milestone as FRG.

## Decisions

### 1. Successor policy, not a new one-version pin

**Choice:** Introduce policy id `factory-gate-v1-hybrid-v2`. Bind proof to
`(pack_id, manifest hash, candidate git SHA, loop run, closed probe list)`.
Do **not** pin `release_version` to a single SemVer. Keep
`factory-gate-v1-hybrid-v1` + `1.33.0` as a historical decoder for existing
1.33 evidence.

**Why:** The defect is the one-version expiry. A `hybrid-v2` that is itself
pinned to `1.39.0` recreates #1036 at the next minor.

**Alternatives considered:**

- Waive hybrid for `1.39.0` only → rejected; that is the 1.33 pattern.
- Delete hybrid and require live process-kill / forge 5xx → rejected; issue
  non-goal, and no safe public injection seam exists.
- Fabricate `--observations` → banned.

### 2. Reuse the existing 1.33 closed matrix

**Choice:** Required-live stays the current live lists:

- scenarios: `clean-item-throughput`, `blocker-taxonomy`,
  `empty-depends-on-stack-honesty`
- composition: `openspec-bearing-item`

Layer A-allowed stays the current `layer_a_probes` owners for every other
required scenario and composition id. The issue names the scenario-level
closed set. The remaining 1.33 composition probes (fix→re-review, forge 5xx,
process-restart, recovery-controller entry, and the rest already on that
matrix) stay Layer A. Do not add new Layer A ids. Do not move a required-live
id onto Layer A.

**Why:** Every required id already has exactly one hybrid owner. Inventing a
smaller Layer A set would leave composition dimensions without an owner and
fail representative composition. Inventing a larger set would violate
“closed set only.”

**Alternatives considered:**

- Required-live the entire Layer B inventory → rejected; the two-item pack
  cannot inject those faults, so the gate stays false.
- Drop unlisted composition probes from Layer A and require live observation
  → rejected; same injection gap.

### 3. `not_observed` fails required-live only

**Choice:** Change the blanket “any `not_observed` fails the gate” rule:

- Required-live `not_observed` / `fail` / `skip` → overall fail.
- Layer A-allowed may stay unobserved on the live loop. A valid TAP hash on
  the same candidate SHA (exact named test, not skipped) MAY satisfy that
  probe (recorded as `pass` + `source: layer_a`).
- Missing, skip, fail, other-commit, dirty checkout, or unreadable TAP →
  that probe fails → overall fail.
- Unknown id with `source: layer_a` → refuse.

Collector continues to project valid Layer A TAP into `pass` + `layer_a` so
a passing artifact need not retain `not_observed` on those ids. The scorer
still treats required-live `not_observed` as fatal even when every Layer A
probe is green.

**Why:** Matches the 1.33 collector shape operators already know, while
removing the version pin that makes 1.34+ fail before scoring.

**Alternatives considered:**

- Leave `frgScenariosPermitPass` as “any `not_observed` fails” and only
  unbind the version check → almost sufficient if the collector always
  projects TAP to `pass`, but the issue requires the scoring rule itself to
  distinguish the two sets. Encode the split in both collector and scorer.

### 4. Candidate SHA remains the Layer A binding, not the version string

**Choice:** Keep the existing probe record fields (`test_file`, `test_name`,
`stdout_sha256`, `candidate_git_sha`). Require every Layer A probe SHA to
equal the bundle’s candidate SHA. Stop requiring
`bundle.release_version === "1.33.0"` / `policy.release_version === "1.33.0"`
for hybrid v2.

**Why:** Temporal proximity and SemVer equality are not proof. The 1.33
runner already hashed TAP to a commit. That is the durable binding.

### 5. Historical v1 stays readable; it does not authorize later versions

**Choice:** `hybridPilotProofValid` (or its v2 successor) accepts 1.33.0
evidence only under hybrid v1 identity. For any other version it requires
hybrid v2 identity and current-candidate provenance. A v1 policy id on a
non-1.33.0 artifact fails closed.

**Why:** Existing 1.33.0 evidence on main must keep verifying. It must not
unlock 1.34+.

### 6. Docs replace the expiry paragraph

**Choice:** Edit `docs/factory-reliability-gate-runbook.md` hybrid section in
place. Keep a short historical v1.33.0 note. Do not leave the sentence
“Hybrid Layer A provenance is refused for any version other than exactly
`1.33.0`” as current policy.

## Risks / Trade-offs

- **[Risk] Layer A TAP is not a live fault injection.** → Mitigation: evidence
  and runbook MUST label source `layer_a`. Reports MUST NOT call it live
  injection. Required-live still forces a real candidate pack loop.
- **[Risk] Closed set becomes a dumping ground.** → Mitigation: adding an id
  requires a later spec change. Unknown `layer_a` is refused now.
- **[Risk] Fixture TAP hashes in unit tests could be mistaken for production
  observations.** → Mitigation: tests inject fixture TAP only through the
  existing verified-bundle seam. Production collector still rejects
  caller-authored pass/status/receipt.
- **[Risk] Existing tests pin `release_version === "1.33.0"` and
  “cannot escape to 1.33.1”.** → Mitigation: keep a 1.33.1-cannot-use-v1
  case; add a 1.34+/non-1.33 v2-can-pass-with-TAP case; do not delete the
  v1 historical lock.
- **[Trade-off] Representative composition still lists process-death and
  forge-5xx as required dimensions.** Those stay hermetically covered
  (already allowed as “observes or hermetically covers”). This change does
  not add live injection.

## Migration Plan

1. Land hybrid v2 in manifest + collector + scorer + tests + runbook +
   `plugin/` mirror in this issue’s implementation.
2. Existing `.agent-pipeline/frg/1.33.0/` evidence is unchanged and still
   verifies under hybrid v1.
3. No retroactive rewrite of older evidence.
4. Later pack-loop / factory-release children (#1035) consume hybrid v2.
   This change does not start that loop.

Rollback: revert the change. The 1.33-only refusal returns. Ship stays on
`--skip-frg` until a successor lands.

## Open Questions

None that block specs or tasks. Closed Layer A set is the existing 1.33
probe matrix. Policy id is `factory-gate-v1-hybrid-v2`.
