## Context

Shipped merge surfaces already exist outside the advance loop:

| Surface | Role |
| --- | --- |
| `pipeline merge <pr>` | Human/operator per-PR squash merge after R2D gates |
| `pipeline merge-queue --milestone …` | Default **dry-run** plan of R2D candidates |
| `pipeline merge-queue … --apply` | Operator-authorized sequential merges via `mergePr` |
| `… --apply --release-when-complete` | After a complete queue, **prepare** a release PR (not tag/merge/publish) |

Structural isolation is already enforced in code/tests (`core/test/merge.test.ts`
loop-isolation: stage handlers must not import `merge.ts`; `dispatch()` must not
call `mergePr`; merge-queue is excluded as a human-gated CLI surface). Config
still strict-rejects unknown `auto_merge`.

What is wrong is **policy language**:

- CLAUDE.md / AGENTS.md golden rule 4: "The pipeline never merges… There is no
  auto-merge path and no `auto_merge` config key — don't add either."
- `pipeline-state-machine` requirement "Never auto-merge": "no merge command
  anywhere in the orchestrator or stage handlers"
- Scattered README/SKILL absolute "never merges" lines that contradict listed
  `/pipeline:merge` and `/pipeline:merge-queue --apply` commands
- `merge-queue-command` still says only a "**future** human-invoked merge-queue
  drive" may merge, while `--apply` has shipped

Maintainer ruling (2026-07-31): never auto-merge **by default**; the operator
SHALL be able to explicitly authorize the process to merge for a given
invocation. Policy that stays: **no autonomous/unattended merge**, not "no
merge capability." Unattended merge remains #662.

## Goals / Non-Goals

**Goals:**

- One honest structural claim: advance never merges; merge only via explicit
  session-bound operator commands.
- Golden rules, living specs, README, and host skills use that claim consistently.
- Public positioning: autonomous intake → green/current/mergeable R2D; merge
  needs operator authority; deployment out of scope; not end-to-end autonomous
  SDLC/ADLC.
- Keep/extend drift-guards so `mergePr` cannot re-enter the advance path and
  docs do not reintroduce absolute "no merge command exists" falsehoods where
  practical.
- Zero product behavior change.

**Non-Goals:**

- Unattended / config-driven auto-merge (#662).
- Merge-queue conflict or CI repair (#675).
- New merge commands, authority expansion, or `auto_merge` key.
- Changing merge gates, squash strategy, or release-when-complete prepare path.
- Rewriting every historical ROADMAP/runbook "pipeline never merges" phrase
  unless it is high-traffic operator surface (prefer surgical hits listed in
  proposal Impact; pilot runbooks may keep "human action" framing if still true
  for that pilot).

## Decisions

### D1 — Rename the invariant: never *autonomous* merge

**Decision:** Treat the product invariant as **no merge reachable from
`pipeline advance` / stage handlers**, not "no merge symbol in the repo."

**Rationale:** `merge.ts` and `merge-queue.ts` live under `stages/` as CLI
handlers, not STAGES entries. Absolute "no merge command in stage handlers"
is false and fights the packaging layout.

**Alternative rejected:** Move merge handlers out of `stages/` in this change —
behavior-neutral refactor, out of scope for docs-and-spec reconciliation.

### D2 — Canonical operator authority wording

**Decision:** Use this closed phrasing on golden rules and high-traffic docs:

1. Advance loop terminal stage is `pipeline:ready-to-deploy` (no merge stage).
2. Merging requires **explicit operator invocation** in the operator's session:
   `pipeline merge <pr>` and/or `pipeline merge-queue … --apply` (dry-run default).
3. No `auto_merge` config key; unattended merge is not enabled by this product
   surface and remains #662's subject.
4. Autonomous **deployment** is out of scope.

**Rationale:** Matches maintainer ruling and merge-queue-command's existing
"human-owned merge authority" intent while naming shipped surfaces.

### D3 — Spec delta strategy

**Decision:**

- **MODIFIED** full requirement block for `pipeline-state-machine` "Never
  auto-merge (structural guarantee)" (prefer keeping the requirement **name**
  for archive stability unless rename is clearer; if renamed, use RENAMED +
  full body under new name carefully — prefer MODIFIED in place with updated
  body).
- **MODIFIED** `merge-queue-command` "The advance loop SHALL never invoke
  merge-queue…" requirement to drop "future drive" and name `--apply`.
- **ADDED** `merge-authority-boundary` for public-docs positioning and
  golden-rule / drift-guard requirements that do not belong in the state-machine
  spine.

**Rationale:** State-machine keeps the structural guarantee; merge-queue keeps
command-local authority; new capability owns cross-cutting operator copy so
README/SKILL acceptance criteria have a home.

### D4 — Drift-guards: code isolation first, light docs guard optional

**Decision:**

- **Must keep** existing structural tests: no stage-handler import of merge for
  advance stages; `dispatch()` body does not call `mergePr`; merge-queue not
  invoked from advance; `auto_merge` rejected at parse.
- **Must extend only if gaps exist** after audit (e.g. assert `pipeline-run`
  advance path does not import merge-queue apply symbols). Prefer extending
  existing `merge.test.ts` isolation section over a new framework.
- **Docs drift-guard:** optional light test that CLAUDE.md / AGENTS.md / README
  front-door do not reintroduce the exact false phrase "no merge command
  anywhere" *or* that they contain the positive "explicit operator" carve-out.
  Prefer positive presence checks over brittle denylists of every synonym.
  If a full phrase guard is expensive or noisy, document a manual acceptance
  grep in tasks and still ship the structural code guard.

**Rationale:** Code isolation is the hard invariant; docs guards help but must
not fail on legitimate "the advance loop never merges" sentences.

### D5 — Mirror regeneration

**Decision:** Edit host skill **sources** under `hosts/`; run
`node scripts/build.mjs` and commit regenerated `plugin/` in the same change
when Claude packaging is mirrored. Never hand-edit `plugin/`.

### D6 — Surgical doc hits

**Decision:** Primary surfaces only (proposal Impact). Do not mass-rewrite
every "never merges" in intake/sweep/release *narrative* where the subject is
"this *subcommand* never merges its PR" (true). Fix only claims that assert the
**product has no merge capability** or that **merge-queue never merges** while
`--apply` exists.

**Heuristic:**

| Claim | Action |
| --- | --- |
| Advance loop never merges | Keep |
| No `auto_merge` key | Keep |
| merge-queue dry-run never merges | Keep for dry-run default |
| merge-queue never merges (absolute, ignoring --apply) | Fix |
| Pipeline never merges / no merge command exists | Fix to operator-authority form |
| intake/sweep "never merges the ROADMAP PR" | Keep (those paths open PRs only) |

## Risks / Trade-offs

- **[Risk] Agents still refuse to run `pipeline merge` because residual copy says
  never merge** → Mitigation: golden rule 4 + SKILL "never does" + README front
  door all name the operator carve-out in one pass.
- **[Risk] Docs over-correct into "pipeline can auto-merge"** → Mitigation: every
  rewrite pairs the carve-out with "not from advance; no auto_merge; unattended
  is #662."
- **[Risk] MODIFIED requirement archive drops scenarios** → Mitigation: copy
  full requirement blocks including unchanged `auto_merge` scenario.
- **[Risk] Phrase drift-guard false positives** → Mitigation: prefer code
  isolation tests; keep docs checks narrow (exact false phrases or required
  positive substrings).
- **[Risk] Scope creep into #662 / #675** → Mitigation: proposal Non-Goals and
  acceptance criterion forbidding behavior change; CI behavior identical.

## Migration Plan

1. Land OpenSpec change artifacts (this step).
2. Implement doc/spec text + preserve tests; regenerate plugin if needed.
3. `openspec validate no-autonomous-merge-policy` + `npm run ci`.
4. Pre-merge archives delta into living specs (existing pipeline pre-merge).
5. Rollback: revert the docs/spec commit; no runtime flag required.

## Open Questions

None blocking. If implementation discovers a living-spec scenario still
asserting "merge-queue never merges" without dry-run/apply distinction, update
under the `merge-queue-command` MODIFIED block rather than opening a second
change.
