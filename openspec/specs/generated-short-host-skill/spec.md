# generated-short-host-skill Specification

## Purpose
TBD - created by archiving change generate-short-host-skill. Update Purpose after archive.

## Requirements

### Requirement: Repository SHALL keep one shared orchestration-contract source

The repository SHALL keep `core/scripts/host-skill.ts` as the single committed one-pager renderer. Its single deep interface SHALL include `renderHostSkill(options?)`, which returns the complete host-neutral SKILL bytes and MAY receive `operationSurface` and `manifests` for deterministic in-process tests. When omitted, those inputs SHALL default to `OPERATION_SURFACE` and `loadOuterHostManifestsPreferHosts()`. The module SHALL export one issue-locked `SKILL_HOST_IDS` tuple containing exactly `claude`, `codex`, `grok`, and `opencode`; that tuple SHALL be the sole generated-host membership source and SHALL NOT contain notify values or lifecycle behavior. The renderer SHALL select those IDs in tuple order, require exactly one manifest for each selected ID, fail closed on missing or duplicate selected IDs, and exclude non-selected manifests such as OMP. It SHALL derive the displayed notify values only from each selected manifest's `material_progress_notify.mapping`; it SHALL NOT own or hardcode a parallel host/surface/tool map. The module SHALL state the follow/notify contract: capture `run_id` from the durable handoff; use `pipeline logs <advance-run-id> --events --follow` for a direct numeric or linked advance and `pipeline loop logs <loop-run-id> --events --follow` for a loop; reattach after an interrupted follow; stop only the matching advance follow on advance `run_complete`; stop the loop-scoped set on `loop_run_complete`, `loop_run_stopped`, or supervisor exit; surface the terminal reason and final summary; and forbid the follower or observer from invoking a merge-capable command. This change SHALL NOT alter CLI dispatch. Issue #971 SHALL be able to call that same interface without copying a host SKILL essay. This change SHALL NOT add Hermes or OpenClaw install logic.

#### Scenario: Shared contract names follow-until-terminal

- **WHEN** a reader opens the shared orchestration-contract source
- **THEN** the source SHALL name `run_id`
- **AND** it SHALL name `pipeline logs <advance-run-id> --events --follow`
- **AND** it SHALL name `pipeline loop logs <loop-run-id> --events --follow`
- **AND** it SHALL require reattach after interruption, stop on a terminal run event or supervisor exit, and a terminal reason plus final summary

#### Scenario: Shared contract forbids follower merge

- **WHEN** a reader opens the shared orchestration-contract source
- **THEN** the source SHALL state that the follower or observer never invokes a merge-capable command
- **AND** it SHALL name at least `merge`, `merge-queue --apply`, `train --merge`, and `ship` as merge-capable

#### Scenario: Supervisor pack can reuse the source

- **WHEN** issue #971 needs a host-neutral one-pager
- **THEN** it SHALL be able to import or render the same committed source
- **AND** this change SHALL NOT add Hermes or OpenClaw install paths

#### Scenario: Notify rows come from outer-host manifests

- **WHEN** the renderer builds the compact notify table
- **THEN** each Claude, Codex, Grok, and OpenCode row SHALL equal that manifest's declared notify `surface`, `tools`, and `filter`
- **AND** `host-skill.ts` SHALL NOT select notify behavior with a second hardcoded host-name map

#### Scenario: Injected manifest fixtures change rendered rows

- **WHEN** a test passes a complete selected-host manifest fixture to `renderHostSkill` and changes one fixture mapping
- **THEN** the corresponding rendered row SHALL change without editing `host-skill.ts`
- **AND** a missing or duplicate selected manifest ID SHALL fail generation

#### Scenario: Issue-locked host membership excludes OMP

- **WHEN** the default outer-host loader returns the repository manifest registry
- **THEN** rendered row membership SHALL equal `SKILL_HOST_IDS` in tuple order
- **AND** OMP or another non-selected manifest SHALL NOT add a row or generated target

---

### Requirement: Generator SHALL emit four short host SKILLs from the shared source

`scripts/build.mjs` SHALL be the sole writer and freshness checker for the `hosts/<id>/SKILL.md` targets derived from `SKILL_HOST_IDS`, which SHALL resolve exactly to `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md`. It SHALL write all four from one call contract through `renderHostSkill`; the four files SHALL be byte-identical. Its write and check target sets SHALL be derived from the same tuple, and a drift guard SHALL fail if ID, rendered-row, write-target, or check-target membership differs. Each SKILL SHALL retain the default numeric issue/PR drive as `pipeline <N>`, tell hosts to execute catalog operations as `pipeline <verb>`, and contain the same compact manifest-derived notify map. They SHALL NOT encode host-specific stage-machine logic. The generator SHALL NOT write `/pipeline:*` markdown command files or Codex `$pipeline:*` yaml agents. The generator SHALL NOT write `plugin/pipeline/skills/pipeline/SKILL.md` or any other path under `plugin/`. `core/scripts/docs-generate.ts` and `scripts/generate-docs.mjs` SHALL NOT read, require, rewrite, or emit any host SKILL.

#### Scenario: Four generated SKILLs exist

- **WHEN** the generator runs on a complete tree
- **THEN** it SHALL write `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md`
- **AND** each file SHALL be produced from the shared source plus `OPERATION_SURFACE`

#### Scenario: Host ID and target membership cannot drift

- **WHEN** generated notify rows, build write targets, and build check targets are enumerated
- **THEN** each set SHALL correspond one-to-one with `SKILL_HOST_IDS`
- **AND** no separately maintained target list SHALL admit OMP or omit a selected host
- **AND** write and check target sets SHALL NOT include a `plugin/` path

#### Scenario: Hosts share one contract

- **WHEN** the four generated SKILL bodies are compared byte-for-byte
- **THEN** they SHALL be identical and carry the same verb set and follow/notify obligations
- **AND** they SHALL NOT contain different stage lists, stage handlers, or stage-order rules per host

#### Scenario: Generator does not emit command packs

- **WHEN** the generator or `scripts/build.mjs` runs
- **THEN** it SHALL NOT write `plugin/pipeline/commands/pipeline:<verb>.md`
- **AND** it SHALL NOT write Codex `pipeline-<verb>.yaml` command agents from `OPERATION_SURFACE`

#### Scenario: Plugin output calls the same renderer directly

- **WHEN** `scripts/build.mjs` runs
- **THEN** it SHALL NOT write `plugin/pipeline/skills/pipeline/SKILL.md`
- **AND** it SHALL NOT create a `plugin/` directory
- **AND** host SKILL generation SHALL consume `renderHostSkill` directly

#### Scenario: Docs generation has no SKILL lifecycle

- **WHEN** `scripts/generate-docs.mjs` runs in write or check mode
- **THEN** it SHALL NOT read, require, compare, or write any host SKILL
- **AND** it SHALL NOT check for `hosts/omp/SKILL.md` or generated table markers

### Requirement: Each generated SKILL SHALL be a one-pager of verb table, follow contract, and doc pointers

Each generated host SKILL SHALL contain an `OPERATION_SURFACE` verb table, the shared follow/notify contract, and the absolute links `https://github.com/accidental-hedge-fund/agent-pipeline/blob/main/docs/packaging.md` and `https://github.com/accidental-hedge-fund/agent-pipeline/blob/main/docs/cli.md`, which remain usable when the SKILL is installed outside the repository. Each generated SKILL SHALL NOT contain the retired engine-essay sections: state-machine walkthrough, per-repo config dump, evals manifesto, or §4 / §4b / §4c bash discovery scripts. Compact policy text SHALL state that default advance/loop is autonomous through `pipeline:ready-to-deploy` and never merges or deploys. It SHALL identify `pipeline merge`, `pipeline merge-queue --apply` (with merge-queue dry-run as the default), `pipeline train --merge`, and `pipeline ship --milestone` as explicit operator-authorized, non-advance surfaces. It SHALL map `Ship milestone vX.Y.Z` to `pipeline ship --milestone vX.Y.Z` without requiring an authorization-file flag. `train` and `ship` SHALL appear in `OPERATION_SURFACE` and in each generated verb table. The follow contract SHALL NOT escalate into any of those merge-capable commands.

#### Scenario: SKILL carries the required three parts

- **WHEN** a reader opens any of the four generated SKILLs
- **THEN** the file SHALL contain a verb table sourced from `OPERATION_SURFACE`
- **AND** it SHALL retain the default numeric `pipeline <N>` issue/PR drive outside that verb table
- **AND** it SHALL contain the follow/notify contract
- **AND** it SHALL point at `docs/packaging.md` and `docs/cli.md`
- **AND** both pointers SHALL be absolute GitHub URLs rather than checkout-relative paths

#### Scenario: Retired essays are absent

- **WHEN** a reader inspects the four generated SKILLs
- **THEN** they SHALL NOT contain a state-machine walkthrough section
- **AND** they SHALL NOT contain a per-repo config YAML dump
- **AND** they SHALL NOT contain an evals manifesto
- **AND** they SHALL NOT contain §4 / §4b / §4c bash discovery scripts

#### Scenario: Train and ship stay on the operation surface

- **WHEN** `OPERATION_SURFACE` and a generated SKILL verb table are inspected
- **THEN** both SHALL list `train` and `ship`
- **AND** the follow/notify contract SHALL NOT instruct the follower to invoke `train` or `ship`

#### Scenario: Compact policy preserves the merge-authority boundary

- **WHEN** a reader inspects any generated host SKILL
- **THEN** it SHALL state that default advance/loop ends at `pipeline:ready-to-deploy` without merge or deploy
- **AND** it SHALL name per-PR merge, merge-queue apply, train merge, and milestone ship as explicit operator-authorized surfaces
- **AND** it SHALL state that merge-queue is dry-run or plan-only unless `--apply` is explicit
- **AND** it SHALL map `Ship milestone vX.Y.Z` to `pipeline ship --milestone vX.Y.Z`

#### Scenario: Discovery frontmatter is host-neutral and includes ship

- **WHEN** a reader inspects generated SKILL frontmatter
- **THEN** it SHALL include the operator phrase `Ship milestone vX.Y.Z`
- **AND** it SHALL NOT use Claude-only `/pipeline`, `/review`, or `/sweep` discovery tokens
- **AND** it SHALL preserve that ordinary advance, single, and loop never merge or deploy

#### Scenario: Verb-table alternatives are complete CLI invocations

- **WHEN** a generated verb table lists a `|` alternative
- **THEN** each alternative SHALL begin with `pipeline`
- **AND** it SHALL include `pipeline ship status --milestone vX.Y.Z`

---

### Requirement: OMP, Tugboat, Eve, and Foreman SHALL NOT receive a generated SKILL

The repository SHALL NOT keep `hosts/omp/SKILL.md`. The generator SHALL NOT emit a SKILL for OMP, Tugboat, Eve, or Foreman. OMP MAY remain an installer host for the CLI tree without a SKILL overlay.

#### Scenario: OMP SKILL is gone

- **WHEN** the change is implemented
- **THEN** `hosts/omp/SKILL.md` SHALL be absent
- **AND** the generator SHALL NOT write that path

#### Scenario: No Eve or Foreman host SKILL

- **WHEN** the host SKILL set is enumerated
- **THEN** there SHALL be no Eve host SKILL
- **AND** there SHALL be no Foreman host SKILL

---

### Requirement: Tests SHALL pin generated SKILL freshness and forbid host-specific stage logic

A co-located unit test SHALL fail when any committed generated host SKILL differs from a fresh generation. A co-located unit test SHALL fail when a generated SKILL encodes host-specific stage-machine logic, when a rendered notify row differs from an injected outer-host manifest fixture, when a selected manifest ID is missing or duplicated, or when `SKILL_HOST_IDS` differs from rendered-row or build-target membership. A co-located unit test SHALL fail when the generator writes a per-verb slash-command or yaml-agent file. A co-located unit test SHALL fail when the generator writes any path under `plugin/`. Hook staging tests and eval fixture-boundary tests SHALL account for all four host SKILL outputs by exact path. Those tests SHALL perform no network, git, or subprocess calls beyond existing isolated hook fixtures and in-process generation.

#### Scenario: Stale generated SKILL fails

- **WHEN** a committed `hosts/claude/SKILL.md` (or Codex, Grok, or OpenCode peer) differs from a fresh generation
- **THEN** the freshness test SHALL fail

#### Scenario: Host-specific stage logic fails

- **WHEN** one generated SKILL names a stage list or stage handler that another generated SKILL omits or contradicts
- **THEN** the host-parity test SHALL fail

#### Scenario: Command-file generation fails the guard

- **WHEN** the generator would write a `pipeline:<verb>.md` or Codex `pipeline-<verb>.yaml` command file
- **THEN** the command-pack test SHALL fail

#### Scenario: Plugin overlay generation fails the guard

- **WHEN** the generator would write `plugin/pipeline/skills/pipeline/SKILL.md`
- **THEN** the plugin-directory test SHALL fail

#### Scenario: Manifest and render drift fails

- **WHEN** a host manifest's notify `surface`, `tools`, or `filter` differs from the generated notify row
- **THEN** the manifest/render parity test SHALL fail

#### Scenario: Manifest selection and target drift fail

- **WHEN** a selected manifest is missing or duplicated, or the rendered row and build target sets differ from `SKILL_HOST_IDS`
- **THEN** generation or the set-parity test SHALL fail before stale output is accepted

#### Scenario: Hook and eval accounting cover all four outputs

- **WHEN** build inputs can change generated host SKILL bytes
- **THEN** the pre-commit hook SHALL stage all four host SKILL paths by exact name
- **AND** eval generated-packaging accounting SHALL recognize and require those same four exact outputs
- **AND** neither boundary SHALL use a broad `hosts/` or `plugin/` allowance

### Requirement: Generated host SKILLs SHALL own only launch, follow, reattach, answer, cancel, and notification behavior

Each generated host SKILL SHALL tell the session host to exec `pipeline <verb>` to launch, follow events with `pipeline logs` / `pipeline loop logs`, reattach through the shared liveness restore or portable follow, answer typed requests through CLI (`pipeline unblock` or the documented answer surface), cancel only through authenticated cancel surfaces, and notify from the active outer-host manifest row. Generated SKILLs SHALL NOT encode recovery recipes, fault classification, retry controllers, merge-from-follow, or a second ledger. Compact policy that names operator-authorized merge and ship surfaces SHALL remain launch documentation only. The follower SHALL still never invoke a merge-capable command.

#### Scenario: SKILL reattach points at shared restore

- **WHEN** a reader opens a generated host SKILL
- **THEN** interrupted follow and dead-worker restore SHALL be described as non-terminal
- **AND** the SKILL SHALL name the shared liveness restore or portable follow CLI
- **AND** it SHALL NOT tell the host to retry `pipeline single` or classify a recipe

#### Scenario: Recovery and retry language is absent from host-owned behavior

- **WHEN** the four generated SKILL bodies are inspected for host-owned behavior
- **THEN** they SHALL NOT instruct the host to classify faults, park as needs-human, or merge because follow stopped
- **AND** they SHALL still list operator-authorized merge and ship as explicit launch surfaces outside follow

---

### Requirement: Host-skill generation SHALL keep OMP argv-only and SHALL NOT promote example supervisors

The generator SHALL continue to emit exactly the `SKILL_HOST_IDS` targets and SHALL NOT write `hosts/omp/SKILL.md`. OMP SHALL remain an installer host that launches the CLI without a SKILL overlay. Hermes and OpenClaw example packs SHALL NOT be added to `SKILL_HOST_IDS`. Direct CLI SHALL remain in supervisor-semantic parity without a generated SKILL.

#### Scenario: OMP still has no generated SKILL

- **WHEN** the generator runs
- **THEN** it SHALL NOT write `hosts/omp/SKILL.md`
- **AND** OMP SHALL still launch the same liveness restore and follow CLI

#### Scenario: Hermes and OpenClaw stay out of generated membership

- **WHEN** `SKILL_HOST_IDS` is enumerated
- **THEN** it SHALL NOT contain Hermes or OpenClaw
- **AND** example packs under `examples/supervisor/` SHALL remain example fixtures
