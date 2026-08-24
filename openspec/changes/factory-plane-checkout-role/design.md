## Context

See `proposal.md` for why. Current law and code:

- Living two-track specs already say pin authority is the factory control **checkout**, Hermes-state is not authority, and ordinary product-repo doctor does not require a pin.
- The identity helper that feeds those rules is GitHub owner/name: `isFactoryControlRepo(config.repo)` is true for every clone of `accidental-hedge-fund/agent-pipeline`. Doctor comments say ordinary product-repo doctor does not require a pin; that predicate undoes the comment for this repo.
- `factory-pin` self-dogfood uses `isFactoryControlPackageMeta` (`package.json` `repository` owner/name). Every clone can write a local `.agent-pipeline/production-engine-pin.json`. That is how a 2026-08-15 `--skip-frg` pin became clone-local law.
- Tugboat and the host launcher already know the live control checkout as `REPO_DIR` (example name `ap-main-control`). They bind `$REPO_DIR/.agent-pipeline/production-engine-pin.json`. Product docs (#1183, `docs/supervisor.md`) already say Hermes-state is not authority.
- `evaluateEngineTrackCheck` already fails pinned intent on `no-frg-*` and already passes inactive (`null`) intent. The bug is that doctor/train never leave intent inactive on a clone of this repo.

**Class vs site (engine-dogfood bar):** the site is "train from `/home/mcomardo/dev/agent-pipeline` died on leftover `no-frg-1.39.1`." The class is: factory-control identity is GitHub owner/name, so every clone of this repository is the factory plane. Shared surfaces: the identity helper used by doctor `install:engine-track`, train/advance two-track default, and `factory-pin` self-dogfood. The next leftover `no-frg-*` pin on another clone or host is refused as factory law without a new mole issue.

## Goals / Non-Goals

**Goals:**

- One checkout-role predicate for factory-plane / two-track default identity.
- Developer clones of this GitHub repo leave two-track policy inactive with no env and no wrapper.
- Live control checkout keeps pinned fail-closed behavior and one pin file.
- GitHub owner/name and `package.json` `repository` stop meaning "this checkout is the factory plane."

**Non-Goals:**

- Shipping `hosts/omp` (#1235) or launcher Node bootstrap (#1236).
- Rewriting Tugboat/Hermes/Buzz.
- Deleting `--skip-frg`.
- Treating Hermes-state as pin authority.
- Hardcoding host paths such as `/home/mcomardo/dev/ap-main-control`.
- Changing promote FRG quality rules (#1041) except which checkout they apply to by default.

## Decisions

### 1. Checkout-role predicate replaces GitHub-name factory identity

**Choice:** Factory-control context is true when the invocation directory is the live control checkout identified by factory-plane `REPO_DIR` or `AGENT_PIPELINE_FACTORY_CONTROL`, or a managed worktree of that directory. It is false when those signals are absent, even if `config.repo` or `package.json` `repository` is `accidental-hedge-fund/agent-pipeline`.

Positive signals (any one):

- `AGENT_PIPELINE_FACTORY_CONTROL` resolves to this checkout (or this managed worktree belongs to that root).
- Factory-plane `REPO_DIR` is set and resolves to this checkout (or this managed worktree belongs to that root).

Never sufficient:

- `config.repo === "accidental-hedge-fund/agent-pipeline"`
- `package.json` `repository` owner/name
- Presence of leftover `.agent-pipeline/production-engine-pin.json`
- Presence of Hermes-state `~/.local/state/hermes-factory/production-engine-pin.json`
- Path name heuristics (`ap-main-control`, `*factory-control*`)

Explicit `--engine-track` / `engine_track` still activates two-track policy without making the checkout factory-control. An explicit pin-path override still grants pin-file authority for already-pinned intent; it does not by itself default doctor/train to pinned.

**Why:** Tugboat/Hermes already pin `REPO_DIR`. Ordinary host `/pipeline` from a clone does not set factory env. Worktrees of the live control checkout must stay factory-control so factory dogfood advances remain pinned. Worktrees of a developer clone must not, because that is the incident.

**Alternatives considered:**

- Keep GitHub-name identity and require `AGENT_PIPELINE_PRODUCTION_PIN` on clones → rejected; host skill boot must not need that env, and it still treats every clone as factory.
- Path glob / hardcoded `ap-main-control` → rejected; site mole, fails the class bar.
- Gitignored role marker file on the live checkout → rejected for this change; extra operator setup, while `REPO_DIR` / `AGENT_PIPELINE_FACTORY_CONTROL` already exist.
- Treat any leftover pin JSON as factory identity → rejected; that is the inverted bug.

### 2. Shared helper, not path-local doctor special case

**Choice:** Replace the GitHub-name predicate at the shared identity seam used by doctor, pipeline-run/train, and factory-pin self-dogfood. Do not add a doctor-only skip for `no-frg-*` on this repo.

`isFactoryControlRepo(config.repo)` MUST NOT remain the two-track default. If a GitHub-name helper remains for docs or remediation strings, it SHALL NOT be named or used as factory-control identity. Other callers that mean "this checkout is the live factory plane" (including factory-owned work-list admission that currently uses the same helper) SHALL use the checkout-role predicate. This change does not alter work-list dependency policy except by stopping GitHub-name from implying factory plane.

**Why:** A doctor-only mole would leave train/advance and factory-pin writing clone-local pins. The next host would need another issue.

**Alternatives considered:**

- Doctor skip when pin is `no-frg-*` on this repo name → rejected; still factory-identifies every clone, and weakens live-control fail-closed if the skip is name-based.
- Env `AGENT_PIPELINE_PRODUCTION_PIN` as the only factory signal → rejected; host skill boot must not require it, and live control already has `REPO_DIR`.

### 3. factory-pin self-dogfood follows the same predicate

**Choice:** Stop treating `package.json` `repository` owner/name as self-dogfood. `factory-pin` from a developer clone without factory-control dir or pin-path override SHALL refuse. Promote on the live control checkout with unset `AGENT_PIPELINE_PRODUCTION_PIN` SHALL write `$REPO_DIR/.agent-pipeline/production-engine-pin.json` only.

**Why:** GitHub-name self-dogfood is how skip pins land in clones and later fail doctor. Pin write authority must be the same class as pin read identity.

**Alternatives considered:**

- Allow clone-local pin writes but ignore them in doctor → rejected; two pin files, same split-brain class as Hermes-state.

### 4. `--skip-frg` stays an escape, not clone law

**Choice:** Keep `--skip-frg` as an operator escape that writes `no-frg-*` + null evidence. On the live control checkout, pinned doctor still fails that marker. On a non-control clone, inactive intent does not fail solely for that leftover file.

**Why:** The issue keeps the escape. The defect is treating a clone leftover as production pin policy.

## Risks / Trade-offs

- [Risk] `pipeline doctor` / `train` on the live control checkout without `REPO_DIR` or `AGENT_PIPELINE_FACTORY_CONTROL` becomes inactive. → Mitigation: factory plane already requires `REPO_DIR` for ship; docs already name that checkout. Do not fall back to GitHub name to "save" that case.
- [Risk] Factory dogfood advances in `.worktrees/<issue>` under the live control checkout lose pinned default if worktree membership is omitted. → Mitigation: checkout-role includes managed worktrees of `REPO_DIR` / `AGENT_PIPELINE_FACTORY_CONTROL` only.
- [Risk] Existing tests assert `isFactoryControlRepo(FACTORY_CONTROL_REPO) === true` and doctor fixtures pass `repo: "accidental-hedge-fund/agent-pipeline"` as factory. → Mitigation: retarget those tests at checkout-role fixtures; add the clone + `no-frg-1.39.1` regression named in the issue.
- [Risk] Operators who promoted from a developer clone via GitHub-name self-dogfood lose that path. → Mitigation: that path is the bug. Use the live control checkout, `AGENT_PIPELINE_FACTORY_CONTROL`, or an explicit pin-path override.

## Migration Plan

- No pin schema change. No second pin file.
- Leftover `no-frg-*` JSON in developer clones may remain on disk; it is inert under inactive intent.
- Live control checkout keeps the existing file at `$REPO_DIR/.agent-pipeline/production-engine-pin.json`.
- Rollback is reverting the identity helper; GitHub-name factory identity would return.

## Open Questions

None. Checkout-role signals (`REPO_DIR`, `AGENT_PIPELINE_FACTORY_CONTROL`, managed worktree of those roots) are the existing factory-plane identity Tugboat already uses. GitHub owner/name is the defect.
