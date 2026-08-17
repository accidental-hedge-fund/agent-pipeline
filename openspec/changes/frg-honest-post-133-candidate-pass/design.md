## Context

See `proposal.md` for why. Current law and code:

- Hybrid v2 (#1036) and the bound pack generator (#1037) are on base.
  `factory-release prepare` starts or resumes a request-bound
  `factory-gate` loop on the candidate track and scores a terminal loop
  with `factory-gate --from-run` (no `--observations`).
- Living `factory-reliability-gate` already refuses caller-authored pass
  and writes `latest.json` `pass: true` only on a genuine scorer pass.
  No post-1.33 `latest.json` with `pass: true` exists. Checked-in
  evidence stops at `1.33.0` (hybrid v1).
- Tugboat thin path still uses the #962 skip policy (`release --skip-frg`
  and `engine-promote --skip-frg`). Living `tugboat-thin-ship` names that
  skip policy as the current release-phase argv. #1039 will drop it
  **after** this proof exists.
- `isReleaseEligibleFrgPass` already encodes structural release
  eligibility (loop, pack, hybrid proof, composition, fingerprints).
  Default attestation is a later mint/tag concern, not this issue's
  missing proof.

**Class vs site (engine-dogfood bar):** the site is "1.34+ has no honest
`pass: true`." The class is: ship-path `--skip-frg` default restore stays
blocked until a machine-checkable honest post-1.33 from-run pass exists.
Shared surfaces: an honest-pass checker next to the existing scorer
predicate, the runbook precondition, and Tugboat's keep-skip rule.
After this lands, the next flip request uses that checker. It does not
need a new mole issue.

## Goals / Non-Goals

**Goals:**

- Run the existing #1037 generator against a candidate engine and persist
  one post-1.33 honest `latest.json`.
- Encode a reusable honest-pass check so later children (#1039–#1041)
  do not invent a second predicate.
- Cite the evidence path and `frg_run_id` on #1038.
- Keep default `--skip-frg` until that check is true.

**Non-Goals:**

- Implementing the Tugboat FRG pack phase (#1039).
- Re-enabling auto-tag FRG (#1040) or refusing `no-frg-*` pins (#1041).
- Changing hybrid v2 ownership or the #1037 start/resume protocol.
- Scoring the product v1.39 milestone as FRG.
- Fabricated observations, live process-kill, or forge-5xx injection.
- Merge, tag, pin, install, or rollback authority.

## Decisions

### 1. Reuse the #1037 generator; do not add a second pack runner

**Choice:** The implementer SHALL invoke `pipeline factory-release
prepare --request <abs.json> --json` (or the documented in-process
equivalent) for a post-1.33 candidate version. Re-invoke until the
bound loop is terminal and `factory-gate --from-run` writes
`.agent-pipeline/frg/<ver>/latest.json`. Do not add a parallel
`factory-gate startLoop` or a one-off script that bypasses prepare.

**Why:** The 1.34 ship-kill was "prepare exists but does not start a
pack." #1037 is that class fix. A second runner would fork the durable
path that #1039 must compose.

**Alternatives considered:**

- Hand-run `pipeline loop --label factory-gate` and score offline →
  rejected; that is the pre-#1037 "bind it yourself" contract.
- Score the product milestone loop → banned by #1035 / this issue.

### 2. Honest-pass checker wraps the existing predicate; it does not
replace scoring

**Choice:** Add a shared, test-injected helper that is true only when
all of the following hold for a `latest.json` (or equivalent evidence
object):

1. `version` is strictly after `1.33.0` (SemVer).
2. `pass: true`.
3. Structural eligibility via `isReleaseEligibleFrgPass` with
   `requireAttestation: false` (HMAC is not this issue's missing proof).
4. Non-empty `run_id`, bound `loop_run_id`, `pack_id: factory-gate-v1`,
   and `pack_provenance.candidate_git_sha`.
5. Required-live scenario / composition ids are present and not
   `not_observed`.
6. Every `source: layer_a` id is on the closed Layer A-allowed set and
   has a TAP hash bound to that same `candidate_git_sha`.
7. Provenance records scoring via `--from-run` (or the in-process
   equivalent). A caller-authored observations file SHALL NOT satisfy.

#1039 and later children SHALL call this helper. They SHALL NOT invent
a second pass definition.

**Why:** Class-over-site. The next `--skip-frg` flip uses one predicate.

**Alternatives considered:**

- Treat any `pass: true` file as enough → rejected; that was the 1.34
  fabrication risk.
- Require HMAC attestation before citing #1038 → rejected; the issue
  asks for honest scoring, not the attestation tick.
- Hard-code version `1.39.0` as the only accepted key → rejected; any
  post-1.33 candidate version that the generator actually scored is
  valid.

### 3. Persist evidence under `.agent-pipeline/frg/<ver>/` and cite it

**Choice:** Keep the existing on-disk layout. Commit the honest
`latest.json` (and its `frg-<run_id>/` sidecar if the generator writes
one) so later children and CI can read the tree. Post a comment on
#1038 with the path and `frg_run_id`. Do not treat a gist or chat
paste as the source of truth.

**Why:** `1.33.0` already lives in that tree. Path-citation matches
the issue acceptance. A committed artifact is what #1040 will later
require.

**Alternatives considered:**

- Issue attachment only, no tree path → rejected; later children and
  the checker need a stable repo path.

### 4. Fail stays fail; this issue stays open

**Choice:** If the bound pack scores `pass: false`, leave
`latest.json` as fail (or omit a pass pointer), keep #1038 open, and
do **not** start #1039. Diagnose with the existing scorer output
(required-live `not_observed`, TAP miss, pack identity). Do not
hand-edit observations to force pass.

**Why:** The issue's hard rule. A waiver is the 1.34 ship-kill.

**Alternatives considered:**

- Close #1038 on "we ran the pack" even if fail → rejected.
- Flip `--skip-frg` behind an operator override → that is #1039's
  later escape, not this proof.

### 5. Tugboat delta is keep-skip only

**Choice:** Add a Tugboat requirement that default `--skip-frg` remains
until the honest-pass checker is true. Do not change the thin phase
list (train → release → finish → promote). #1039 owns the FRG pack
phase.

**Why:** Encoding the blocker in Tugboat law stops a premature flip
without implementing the later child.

**Alternatives considered:**

- Spec only in `factory-reliability-gate` → weaker; Tugboat is the
  surface that currently hard-codes skip.
- Implement the FRG phase now → out of scope (#1039).

## Risks / Trade-offs

- **[Risk] The live candidate pack does not pass on the first run.** →
  Mitigation: fail stays fail; issue stays open; do not waive. Re-invoke
  the same bound `loop_run_id`. Do not start a second unbound pack.
- **[Risk] Implementers score a product milestone by habit.** →
  Mitigation: checker refuses a work-list that is not the request-bound
  `factory-gate` pack. Spec scenario names the milestone refusal.
- **[Risk] `1.33.0` `pass: true` is mistaken for this proof.** →
  Mitigation: checker requires version strictly after `1.33.0`.
- **[Risk] A hand-edited `latest.json` is committed.** → Mitigation:
  checker requires from-run provenance and refuses observations-file
  authority. Review treats a pass without matching `loop_run_id` as
  fail.
- **[Trade-off] Attestation is not required for this issue's pass.**
  Tagging and pin children may still require HMAC later. That is
  deliberate: this issue unblocks the proof, not auto-tag.

## Migration Plan

1. Land the honest-pass helper + unit tests + runbook sentence +
   Tugboat keep-skip spec (this change's code/docs slice).
2. Run `factory-release prepare` on a post-1.33 candidate. Re-invoke
   until terminal. Persist `latest.json` only if the checker is true.
3. Comment on #1038 with path + `frg_run_id`.
4. If fail: stop. Do not flip `--skip-frg`. Do not close the issue.
5. #1039 reads the helper. Auto-tag (#1040) and pin (#1041) stay later.

Rollback: revert the helper and keep-skip delta. Existing `--skip-frg`
default remains. No Tugboat behavior changes in either direction.

## Open Questions

None that block specs or tasks. Any post-1.33 SemVer the generator
actually scored is acceptable. Attestation is out of this issue's
honest-pass contract.
