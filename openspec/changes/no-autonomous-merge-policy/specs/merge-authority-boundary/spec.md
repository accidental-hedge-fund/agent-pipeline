## ADDED Requirements

### Requirement: Public product positioning SHALL state autonomous-through-ready-to-deploy with operator-owned merge
Operator-facing product docs (at minimum the repository `README.md` front-door summary and the host skill entry summaries under `hosts/*/SKILL.md`) SHALL describe agent-pipeline as autonomous from issue intake through a green, current, mergeable `pipeline:ready-to-deploy` result. They SHALL state that merging requires explicit session-bound operator authority and that autonomous deployment is out of scope. They SHALL NOT describe the current product as an autonomous end-to-end SDLC/ADLC that merges and deploys without an operator.

#### Scenario: README front door names the boundary
- **WHEN** a reader opens the repository `README.md` product summary
- **THEN** it SHALL state that the pipeline does not auto-merge unattended and that the advance path ends at ready-to-deploy
- **AND** it SHALL NOT claim there is no operator merge capability while documenting `pipeline merge` or `merge-queue --apply`

#### Scenario: Host skills do not over-claim end-to-end autonomy
- **WHEN** `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` entry descriptions and "never does" (or equivalent) sections are read
- **THEN** they SHALL keep deployment out of scope
- **AND** they SHALL NOT claim the skill autonomously merges or deploys as part of the advance loop

---

### Requirement: Golden-rule conventions SHALL state no-autonomous-merge with operator carve-out
The repository conventions golden rule that previously asserted "the pipeline never merges" (CLAUDE.md golden rule 4 and the AGENTS.md twin) SHALL state **no autonomous merges**: the advance loop stops at `pipeline:ready-to-deploy`; merging happens only through explicit operator invocation (`pipeline merge` / `/pipeline:merge` per-PR; `merge-queue --apply` batch with dry-run default); the invoking operator is the session-bound merge authority; no `auto_merge` config key and no unattended merge path SHALL be added here; unattended merge remains a separate evidence-gated product decision.

#### Scenario: CLAUDE.md and AGENTS.md agree
- **WHEN** CLAUDE.md golden rule 4 and AGENTS.md golden rule 4 are compared
- **THEN** both SHALL express no-autonomous-merge with the same operator carve-out surfaces
- **AND** neither SHALL claim that no merge command exists in the product

#### Scenario: Golden rule forbids auto_merge config
- **WHEN** the golden-rule text is read
- **THEN** it SHALL forbid introducing an `auto_merge` config key that enables unattended merge

---

### Requirement: Operator skill copy SHALL name merge and merge-queue --apply as explicit, non-advance surfaces
Host skill documentation that lists merge-related commands SHALL present `pipeline merge` (or `/pipeline:merge`) and `pipeline merge-queue` with `--apply` as operator-invoked surfaces that are never called by the advance loop. Merge-queue documentation SHALL keep dry-run as the default and SHALL NOT claim that merge-queue never merges while `--apply` is a documented mode.

#### Scenario: SKILL lists both operator merge surfaces
- **WHEN** the host skill command list and "never does" policy text are inspected
- **THEN** they SHALL name per-PR merge and merge-queue apply as operator-only
- **AND** they SHALL state that the advance loop never invokes them

#### Scenario: Dry-run default remains explicit
- **WHEN** merge-queue is described without `--apply`
- **THEN** docs SHALL state that the default is dry-run / plan-only with no merges

---

### Requirement: Advance-loop isolation of mergePr SHALL remain drift-guarded
The test suite SHALL continue to enforce that `mergePr` (and merge-queue plan/drive entry points used for real merges) are unreachable from the advance loop dispatch path and from autonomous stage handlers. A regression in that isolation SHALL fail CI. Tests MAY exclude the dedicated merge and merge-queue CLI modules themselves from the "stage handler must not import merge" scan when those modules are human-gated CLI surfaces rather than advance stages.

#### Scenario: Isolation tests fail if advance gains mergePr
- **WHEN** the advance dispatch function body is changed to call `mergePr`
- **THEN** the loop-isolation unit test SHALL fail

#### Scenario: Stage handlers stay merge-import free
- **WHEN** an advance-path stage handler file imports the merge module for the purpose of merging during a stage transition
- **THEN** the loop-isolation unit test SHALL fail
- **AND** the human-gated `merge.ts` / `merge-queue.ts` modules themselves MAY remain excluded from that import scan
