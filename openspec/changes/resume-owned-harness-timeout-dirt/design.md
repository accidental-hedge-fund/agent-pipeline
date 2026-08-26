## Context

See `proposal.md` for motivation and the lyric-utils `#758` deadlock.

**Class vs site (engine-dogfood bar):**

| Question | Answer |
| --- | --- |
| Class | Interrupted product-mutating harness mutation ownership is not durable. Dirt-trust gates then treat pipeline-owned leftovers as unknown product dirt. |
| Site | Format-gate pre-flight inside `resumeFromImplementing` after an implement timeout that left product porcelain (lyric-utils `#758`, engine `v1.39.12`). |
| Shared law | Classifier + durable ownership record + `checkpoint_owned_harness_dirt` recipe + dirt-trust gates + implementing-resume completeness. |
| Next identical fault | Timeout or dead holder after product edits at implement, fix, test-fix, or pre-merge auto-fix, then a new process hits any dirt-trust gate. That path MUST use this contract. A format-gate skip only on implementing-resume is a mole. |

**Current constraints:**

- Format-gate auto-fix pre-flight fail-closes on any product porcelain (`harness-format-lint-gate`). That unknown-dirt rule stays.
- Same-process implement timeout already has salvage (`harness-uncommitted-salvage`), but it does not help when the outer process dies before salvage, or when HEAD already moved (intermediate commit) and a later resume skips the implementer because commits exist ahead of base (`implementing-resume`).
- Engine scratch is a different class (`engine-scratch-recover`). Product leftovers MUST NOT be reclassified as scratch.
- Dead-holder interrupt is not `workflow-engine-defect` (`durable-blocker-classification`). Resume already re-enters implementing; this change supplies ownership so that resume does not false-human at the next dirt gate.
- Host-local run-store and issue-run lock are the supported concurrency scope for worktree dirt (same as other host-local state).

## Goals / Non-Goals

**Goals:**

- Durable mutation ownership that hydrates in a new process.
- Shared leftover-vs-unknown classification at every dirt-trust gate.
- Deterministic checkpoint of owned leftovers, then completeness evaluation (resume implementer if incomplete).
- Unknown operator dirt stays fail-closed.
- One recipe/classifier so the next timeout-then-retry does not need a new mole issue.

**Non-Goals:**

- Weakening format-gate unknown-dirt fail-closed.
- Treating product files as engine scratch.
- LLM-first recovery or `repair_pipeline_item` as the first owned-leftover action.
- Auto-merge, review override, or a merge stage.
- Cross-host mutual exclusion of worktree dirt (two hosts, two worktrees).
- Reconstructing authorship of a single path when the operator edits the managed worktree after a hard kill with no post-snapshot.

## Decisions

### D1: Host-local durable ownership record (not GitHub, not in-memory)

**Decision:** Persist a versioned ownership record in the existing run-store (or the same host-local durable directory used for run artifacts), keyed by domain + issue + attempt identity. Fields at minimum: `schema_version`, issue, stage, attempt id, worktree path, pre-HEAD, pre-porcelain (path → status + blob identity), in-flight flag, last-known/post porcelain when written, harness result class (`timeout` / `crash` / `success` / `interrupted`). Hydrate on every new launcher. Clear in-flight only when the attempt completes with no owned leftovers (success, or checkpoint+clean).

**Rationale:** The deadlock is a new process with no memory of the harness. GitHub is the wrong store for worktree porcelain. In-memory dies with the process.

**Alternatives:** GitHub comment/artifact (rejected: slow, leaks porcelain, not needed cross-host). Worktree-local marker file (rejected: salvage already excludes markers; a marker is not a porcelain snapshot). Candidate-integrity manifests (rejected: those snapshot approved PR heads, not uncommitted implement dirt).

### D2: Pre-snapshot before spawn; last-known porcelain on timeout and on a bounded heartbeat

**Decision:** Write and durable-flush the pre-snapshot **before** the harness child is spawned. On the harness timeout/crash path, write post-snapshot then checkpoint when the process can still run. Also refresh last-known porcelain on a bounded heartbeat while the harness is in-flight so a SIGKILL still leaves a last-known post. Owned leftovers are the last-known (or post) product porcelain delta versus pre. Product paths dirty now that are not in that owned set are unknown.

**Hard-kill with only pre-snapshot (no last-known after pre):** treat current product porcelain in the managed worktree as owned. The worktree is exclusive to the issue-run. Operator edits after death and before retry may be checkpointed. That is narrower than today's operator-must-inspect deadlock and is documented.

**Rationale:** Pre-only cannot distinguish post-timeout operator edits when a post-snapshot exists. Post/last-known is the ownership evidence the format gate lacks today. Heartbeat is the class fix for outer-process kill (the `#758` shape).

**Alternatives:** Pre-only always (rejected: cannot fail-closed on later operator dirt). Checkpoint-commit on every heartbeat (rejected: noisy, races the harness). mtime vs kill clock (rejected: fragile).

### D3: Shared ternary classifier — scratch | owned | unknown-product

**Decision:** Extend the shared porcelain classifier (same module family as `classifyWorktreeDirt`) so dirt-trust sites see three buckets. Scratch stays the engine-known non-product set. Owned is the ownership delta above. Unknown product is everything else product-relevant, including recognized lockfiles (still folded by the lockfile path, never called scratch). Missing ownership record ⇒ no owned bucket ⇒ today's fail-closed unknown product dirt.

**Rationale:** Format-gate, test-gate, salvage, and resume must not invent parallel lists. Engine-scratch recover's drift inventory already exists; this change adds an ownership-consultation disposition so a new dirt-trust site cannot ignore leftovers.

**Alternatives:** Format-gate special case on implementing-resume (rejected: mole). Classify leftovers as scratch (rejected: product files would skip commit).

### D4: Recover before the gate; never auto-format owned leftovers

**Decision:** `dispatchResume` / `resumeFromImplementing` / format-gate pre-flight / test-gate dirty trust consult ownership first. If owned leftovers exist, run `checkpoint_owned_harness_dirt` (salvage-equivalent commit of **owned paths only**, existing salvage subject/trailers/exclusions). Then re-evaluate porcelain. Format-gate auto-fix MUST NOT commit owned leftovers as `chore: auto-format`. Unknown dirt that remains after checkpoint still blocks before any auto-fix command.

**Rationale:** Auto-format sweeping harness WIP is the bug the pre-flight exists to prevent. Checkpoint is explicit pipeline authorship.

**Alternatives:** Skip format-gate when dirty after timeout (rejected: unknown dirt would also skip). Resume implementer on a dirty tree without checkpoint (rejected: next format-gate in the same process still fail-closes).

### D5: Commits-ahead is not implement completeness when the last attempt is interrupted

**Decision:** `implementing-resume` may take the post-implement path (format/test → push → PR) only when there is no interrupted in-flight implement attempt with owned leftovers. After checkpoint, evaluate the shared implement-deliverable contract. Missing deliverable ⇒ re-invoke the implementer. Satisfied + clean + gates green ⇒ post-implement path without an empty commit.

**Rationale:** `#758` had an intermediate commit plus 12 unfinished files. Skipping the implementer because HEAD is ahead of base is the resume mole.

**Alternatives:** Always salvage and skip to review (rejected: ships incomplete implement). Always restart from `ready` (rejected: discards the intermediate commit).

### D6: Recipe `checkpoint_owned_harness_dirt` is deterministic and first-class

**Decision:** Add `checkpoint_owned_harness_dirt` to the engine-owned recovery sequence, after `unlink_engine_scratch` and before `repair_pipeline_item`. Production controller claims it when owned-leftover evidence is current. Success does not mint a human hold and does not consume implementer-repair budget. Same recipe for `pipeline single`, loop, and train. Residual owned-leftover block kind is `harness-failure` (projects `workflow-engine-defect` / recover), never `needs-human`.

**Rationale:** Class over site. LLM-first repair is an anti-goal. False-human is an anti-goal.

**Alternatives:** Only call checkpoint from format-gate (rejected: test-gate and resume would still mole). Use `repair_pipeline_item` first (rejected: LLM as first recoverer).

### D7: Coverage is every product-mutating harness invoke, attached at the shared round helper

**Decision:** Write the pre-snapshot at the shared harness-round / invoke seam used by implement, fix-round, test-fix, and pre-merge auto-fix. Path-local snapshot only in planning.ts is incomplete.

**Rationale:** The next identical fault will not be implement-only.

### D8: Terminal evidence names the disposition

**Decision:** Emit a structured run-store event (stable kind such as `harness_mutation_ownership`) with disposition `recovered` | `checkpointed` | `resumed` | `rejected`, plus issue, attempt id, owned path count, and unknown path disclosure when rejected. Surface the same tokens in the stage summary / blocker comment when a reject occurs.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Hard kill with no last-known claims later operator edits as owned | Prefer heartbeat last-known; document managed-worktree exclusivity; unknown dirt after a post-snapshot still fail-closes. |
| Heartbeat I/O during long implement | Bounded interval; porcelain status only; fail open on heartbeat write (pre-snapshot still exists). |
| Salvage of incomplete implement ships a bad commit | After checkpoint, re-invoke implementer unless deliverable is already satisfied. Gates still run before PR. |
| Stale in-flight claims a later clean run's operator dirt | Clear in-flight on attempt success/clean; bind record to attempt id and pre-HEAD. |
| Dual classifier drift (scratch vs owned) | One helper, one inventory row per dirt-trust site; drift-guard fails on new sites. |
| Same-process salvage already exists and might double-commit | Checkpoint is salvage with owned pathspec; if same-process timeout already salvaged, porcelain is clean and retry is a no-op. |

## Migration Plan

1. Specs + design land in this change (planning). No runtime change yet.
2. Implementation: ownership record + classifier + snapshot-before-spawn + recipe + gate/resume wiring; regenerate `plugin/` with any `core/` edit.
3. No data migration. Absent records fail-closed as today.
4. Rollback: stop writing snapshots; gates revert to unknown-dirt-only. Do not leave a half-wired classifier that treats leftovers as scratch.
5. Archive into living specs on pre-merge when acceptance is green.

## Open Questions

None that block specs or tasks. Heartbeat interval is an implementation knob; specs require a last-known refresh during in-flight, not a specific number of seconds.
