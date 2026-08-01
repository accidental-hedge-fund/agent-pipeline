## Why

Golden-rule and living-spec language still claim a stricter invariant than shipped
reality: "the pipeline never merges" / "no merge command anywhere in the
orchestrator or stage handlers." Operator-invoked merge surfaces already exist
(`pipeline merge <pr>`, `merge-queue --apply` / `--release-when-complete`). The
2026-07-31 reliability audit left this as the last unresolved policy conflict;
the maintainer ruling is **no autonomous/unattended merge**, not "no merge
capability." Specs and operator docs must state that honest boundary so agents
and humans do not treat shipped merge commands as forbidden or invent
`auto_merge`.

## What Changes

- Reword **CLAUDE.md golden rule 4** (and the AGENTS.md twin) from "never merges"
  to **no autonomous merges**: the advance loop stops at
  `pipeline:ready-to-deploy`; merge happens only through explicit operator
  invocation (`/pipeline:merge` per-PR; `merge-queue --apply` batch, dry-run
  default); the invoking operator is the session-bound merge authority; no
  `auto_merge` config key and no unattended merge path — unattended merge remains
  gated on #662's shadow-calibrated evidence standard.
- Rewrite the **`pipeline-state-machine` "Never auto-merge"** requirement so the
  structural claim is accurate: no merge stage in `STAGES`, no merge call
  **reachable from `pipeline advance`**, merge surfaces exist only behind
  explicit operator commands; name **`pipeline merge` and `merge-queue --apply`**
  in the carve-out. Keep the `auto_merge` strict-rejection requirement and its
  scenario unchanged.
- Align public positioning in **README**, **hosts/\*/SKILL.md**, and related
  operator copy: autonomous from intake through a green, current, mergeable
  `ready-to-deploy` result; merge requires explicit session-bound operator
  authority; autonomous deployment is out of scope; do **not** describe the
  product as an autonomous end-to-end SDLC/ADLC.
- Update **`merge-queue-command`** authority wording that still says a "future"
  human-invoked drive — `--apply` has shipped; dry-run remains default.
- Preserve structural tests (no stage transition calls merge-queue; `auto_merge`
  rejected at parse); keep/extend a drift-guard that **`mergePr` is unreachable
  from the advance loop**.
- Docs-and-spec only: **zero runtime behavior change**. Regenerate `plugin/` if
  host skill sources change. Not **BREAKING**.

## Capabilities

### New Capabilities

- `merge-authority-boundary`: Canonical operator-facing merge policy — autonomous
  advance ends at ready-to-deploy; only session-bound explicit operator commands
  may merge; no `auto_merge` / unattended merge; public docs must not over-claim
  end-to-end autonomous SDLC/ADLC; drift-guards for docs and advance-loop
  isolation of `mergePr`.

### Modified Capabilities

- `pipeline-state-machine`: Replace the false "no merge command anywhere in the
  orchestrator or stage handlers" structural guarantee with never-*autonomous*-
  merge: no merge stage in `STAGES`, no merge reachable from `pipeline advance`,
  explicit operator carve-out naming `pipeline merge` and `merge-queue --apply`;
  retain `auto_merge` parse rejection.
- `merge-queue-command`: Align the human-owned merge-authority requirement with
  shipped `--apply` (and related release-when-complete prepare path) instead of
  "future drive" language; dry-run remains default; still never called from
  advance.

## Acceptance criteria

- [ ] CLAUDE.md golden rule 4 states **no autonomous merges** (advance stops at
  `pipeline:ready-to-deploy`; merge only via explicit operator invocation of
  `pipeline merge` / `merge-queue --apply`; no `auto_merge` key; unattended
  merge not introduced here / remains #662-gated) — not the absolute "pipeline
  never merges / no merge command" wording.
- [ ] AGENTS.md golden rule 4 matches the same policy (no contradictory twin).
- [ ] `openspec/specs/pipeline-state-machine/spec.md` "Never auto-merge" (or
  renamed equivalent) no longer claims there is no merge command in orchestrator
  or stage handlers; it claims no merge stage in `STAGES`, no merge reachable
  from `pipeline advance`, and names `pipeline merge` and `merge-queue --apply`
  as operator-only surfaces.
- [ ] The `auto_merge` config-key rejection requirement and its scenario remain
  present and enforceable (strict-schema parse error).
- [ ] README front-door and merge-related sections state that the product is
  autonomous through ready-to-deploy, that merge requires explicit session-bound
  operator authority, and that it does not auto-merge unattended — without
  denying the existence of operator merge commands.
- [ ] `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` "never does" / merge
  policy copy name both `pipeline merge` and `merge-queue --apply` as
  operator-invoked (not advance) surfaces; dry-run default for merge-queue is
  clear; autonomous deployment remains out of scope.
- [ ] Public docs do **not** describe agent-pipeline as a fully autonomous
  end-to-end SDLC/ADLC that merges and deploys without an operator.
- [ ] `merge-queue-command` living-spec authority language no longer refers to
  apply/drive as only "future"; it names explicit operator `--apply` (dry-run
  default) and retains advance isolation + no `auto_merge`.
- [ ] Structural unit tests still pass: advance/stage handlers do not call
  `mergePr` / merge-queue drive; `auto_merge` rejected at parse. A drift-guard
  that `mergePr` is unreachable from the advance loop remains (or is added if
  incomplete).
- [ ] No stage-machine edges, merge handler gates, merge-queue apply algorithm,
  or config schema keys change except documentation / comment accuracy.
- [ ] After host skill edits, `plugin/` is regenerated and `build.mjs --check`
  is clean; `openspec validate no-autonomous-merge-policy` and `npm run ci` pass.

## Impact

- `CLAUDE.md`, `AGENTS.md` — golden rule 4 reword.
- `README.md` — front-door auto-merge / human-merge positioning; any absolute
  "pipeline never merges" claims that contradict operator merge surfaces.
- `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md` (+ regenerated `plugin/`
  mirror) — "What this skill never does" and related merge-policy copy.
- `openspec/specs/pipeline-state-machine/spec.md` — structural never-autonomous-
  merge requirement text (via this change's delta, archived later).
- `openspec/specs/merge-queue-command/spec.md` — authority carve-out wording.
- `openspec/project.md` Out of scope bullet (if still absolute "Auto-merging
  PRs — human owns the merge button" without naming operator commands) —
  align if it over-claims.
- `core/test/merge.test.ts` (and any merge-queue isolation tests) — preserve /
  lightly extend drift-guards only; no product behavior change.
- Optional comment-only touch-ups in engine files that restate the old absolute
  rule incorrectly — wording only.
- **Out of scope:** unattended merge (#662), merge-queue conflict/CI repair
  (#675), any new merge automation or authority expansion.
