## Context

See `proposal.md` for why. Current law and code:

- Advance writes `.agent-pipeline/runs/<issue>-<timestamp>/events.jsonl` through `appendEvent`. `pipeline logs <run-id> --events --follow` dumps or tails that file and, by default, exits 0 on `type: "run_complete"` (`isAdvanceRunCompleteLine`).
- Loop writes a different state home (`~/.local/state/agent-pipeline/loop/runs/…`) and is observed with `pipeline loop logs`. Loop events use `{ seq, time, kind, data }`. Early `loop_run_handoff` is a stdout JSON line.
- Train (`runTrain` / `runTrainCommand`) logs unstructured lines. `--json` stdout is exactly one `train_status` object (`schema_version: 1`). After an advance wave is ready, train already flushes `loop_run_handoff` on **stderr** so `--json` stdout stays clean. There is no train-level run ID or `events.jsonl`.
- `material-filter.mjs` selects advance `type` values, loop `kind` values, and `ship_phase`. Train lines are dropped.
- Host skill §4 / §4b teach `logs … --events --follow | material-filter.mjs`. Train has no equivalent, so hosts grep stdout.

Locked issue decisions: generic run-log layout; existing `pipeline logs` (no train-specific log command); versioned envelope with sequence, timestamp, train run ID, event kind, issue/PR identity; compatible terminal; link wave loop run IDs; keep raw engine output on linked wave logs.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is one host grepping `train` stdout (false matches on `/training`, `0 errors`, CI poll spam). The class is: train is a first-class run-store producer, same observation path as advance.
2. **Shared surfaces.** Generic run-store + `appendEvent`, `pipeline logs --events --follow`, `material-filter.mjs`, host-notify skill contract. Not a train-local logger or a new `pipeline train logs`.
3. **Next identical fault.** The next host (Codex, Grok, ship adapter) follows `pipeline logs <train-run-id> --events --follow | material-filter.mjs` and drills into `train_loop_linked`. It does not need a new mole issue.

## Goals / Non-Goals

**Goals:**

- Give every `pipeline train` invocation a durable train-level run ID and append-only `events.jsonl` in `.agent-pipeline/runs/<run-id>/`.
- Publish that ID early enough that a host can follow before the first wave.
- Emit a closed catalog of train-level material events, including wave-loop linkage.
- End the stream with `type: "run_complete"` so existing until-terminal logs follow exits.
- Teach the shared material filter and host skill notify maps the train kinds.

**Non-Goals:**

- `train --dry-run` (separate issue).
- `pipeline train logs` or storing train events in the loop state home.
- Changing merge-first, frontier, recovery, or independent-sibling merge law.
- Copying child loop/advance/CI/harness stdout into the train stream.
- Rewriting Tugboat/ship watchers in this change (they MAY consume the new stream later).
- A second recoverer inside `train.ts`.

## Decisions

### 1. Generic run-store layout; no train-specific logs command (primary)

**Choice:** Initialize `.agent-pipeline/runs/<train-run-id>/` (same layout as advance: `run.json`, `events.jsonl`, `terminal.log`). Hosts observe with `pipeline logs <train-run-id> --events [--follow]`. Do not add `pipeline train logs`. Do not write train events under the loop state home.

**Why:** The locked host interface is the command hosts already use for advance. Loop needed a nested command because its state home is not `.agent-pipeline/runs/`. Putting train there would force a second command and a second follow recipe.

**Alternatives considered:**

- Loop state home + `pipeline loop logs` for train → rejected. Train is not a loop run; mixing IDs would collide with wave loop IDs.
- `pipeline train logs` → rejected by locked decisions.

### 2. Train run ID is `train-<timestamp>`, not an issue-prefixed advance ID

**Choice:** `runIdFor` stays issue-scoped for advance. Train mints `train-<YYYY-MM-DDTHH-MM-SS-mmmZ>` (filesystem-safe, millisecond precision, same timestamp transform as `runIdFor`). `run.json` identifies the run as a train (selector, merge mode, ordered issues when known). It SHALL NOT set `issue` to one work-list number as if this were a single-issue advance.

**Why:** `pipeline logs` lists every basename under `.agent-pipeline/runs/`. An issue-prefixed ID would look like an advance run for the first work-list item. `initRunDir` today requires `issue: number`; implementation SHALL extend run identity so a train run is not a fake single-issue record (optional/null issue plus train metadata, or an equivalent explicit train marker). Tests MUST fail if `run.json` is indistinguishable from an advance run for issue N.

**Alternatives considered:**

- Use the first work-list issue as `run.json.issue` → rejected. Multi-item identity would be a lie.
- Opaque UUID → harder to scan in `pipeline logs` listings next to existing timestamped IDs.

### 3. Advance-shaped envelope (`type` + `at`) plus `seq` and `run_id`

**Choice:** Each train event is one JSON line through `appendEvent` with `schema_version: 1`, monotonic `seq` (1-based per train run), `type` (event kind), `at` (ISO-8601 UTC), and `run_id` (the train run ID). Issue and PR fields are present when the event is about one item/PR. Unknown fields are preserved. `schema_version` stays `1`.

Use `type`, not loop `kind`, so `isAdvanceRunCompleteLine` and the generic reader keep working. The issue’s “event kind” is the `type` value.

**Why:** Compatible terminal detection already keys on `type: "run_complete"`. Loop `{ kind, data }` would require a new logs reader and a new until-terminal predicate.

**Alternatives considered:**

- Loop envelope (`kind`/`data`) in the generic store → logs until-terminal would hang unless we extend `isAdvanceRunCompleteLine`.
- Dual `type` and `kind` on every line → redundant; hosts already branch on one discriminator per stream.

### 4. Compatible terminal is `type: "run_complete"`

**Choice:** The last event on a finished or failed train (including STOP/hold with no remaining schedulable work, and command-level failure after the store exists) is `run_complete`. Payload includes at least `final_state`, `elapsed_ms`, and enough summary to reconstruct complete/blocker/item counts (additive fields; unknown-field tolerant). Write it in a `finally` path so a normal non-crash exit does not hang `logs --follow`. Do not emit a second train-only terminal kind as the only stop event.

**Why:** `pipeline logs --events --follow` already exits on that type. A `train_run_stopped` kind would require a logs-command change, which the locked interface said not to add.

**Alternatives considered:**

- `train_run_complete` only → until-terminal would hang with today’s CLI.
- Skip `run_complete` on failure → same hang.

### 5. Early handoff on stderr; `--json` stdout stays one `train_status`

**Choice:** After the train run directory exists and `events.jsonl` is readable, before the first advance wave, flush one JSON line on **stderr** with `kind: "train_run_handoff"`, `schema_version: "1"`, `run_id`, `run_dir`, and absolute `events` path. Do not write that object to `--json` stdout. Add additive `run_id` on the final `train_status` object (`schema_version` remains `1`). Keep existing per-wave `loop_run_handoff` on stderr.

**Why:** `train --json` already forbids extra stdout JSON (`#1184`). Loop can use stdout for handoff because loop JSON is a different contract. Stderr is the established train channel for `loop_run_handoff`.

**Alternatives considered:**

- Handoff on stdout always → breaks `train --json`.
- Only put `run_id` on final `train_status` → hosts cannot follow a 4-hour train until it ends.

### 6. Closed train `type` catalog; child raw output stays on linked streams

**Choice:** Train-level `type` values:

| `type` | When |
| --- | --- |
| `run_start` | Store init |
| `train_work_list_resolved` | Ordered issue list is known |
| `train_wave_started` | An advance-wave (frontier) begins |
| `train_loop_linked` | Wave loop run ID is known and the loop store is confirmed (absolute `events` path when known) |
| `train_item_started` | A work-list issue begins train work in the current wave or merge prelude |
| `train_item_completed` | That issue reaches a train terminal (`ready-to-deploy`, `needs-human`, `blocked`, `already-integrated`, `error`, `parked`) |
| `train_pr_created` | Train observes a linked PR number for an item |
| `train_merge_attempted` | Merge-mode merge mutation is invoked |
| `train_merge_proven` | Merge-result containment in fetched base is proven |
| `train_merge_integrated` | Item counts as integrated (including already-integrated skip) |
| `train_sibling_halted` | An item is held/parked while proven-independent siblings continue |
| `train_wave_ended` | That advance wave returns |
| `run_complete` | Train process is done |

Omit `train_loop_linked` when no live loop store is confirmed (same honesty rule as `loop_item_advance_linked`). Do not copy eslint/CI/harness/Next.js stdout onto the train stream.

**Why:** Matches the issue catalog and keeps the train file host-notify-sized. Drill-down uses linkage, not duplication.

**Alternatives considered:**

- Tee child stdout into train `events.jsonl` → recreates the grep problem.
- Only emit `run_start` / `run_complete` → hosts still cannot filter waves/merges.

### 7. Material filter and skill notify consume the train stream

**Choice:** Add a single-sourced `TRAIN_MATERIAL_KINDS` list covering the catalog above (including `run_start`, `run_complete`, `train_loop_linked`). Drift-guards treat train kinds like advance/loop kinds. Host skills add a train orchestration subsection: parse `train_run_handoff`, follow `pipeline logs <train-run-id> --events --follow \| material-filter.mjs`, and dual-follow a linked loop run the same way §4b dual-follows advance. Do not teach `tail -F \| grep` of train stdout as the primary path.

**Why:** The issue’s payoff is that `material-filter.mjs` covers train. That is not automatic: the filter currently drops unknown types.

**Alternatives considered:**

- Reuse only existing advance types so the filter is unchanged → cannot name wave/merge/sibling events.
- Host-only docs without filter changes → hosts keep grepping.

### 8. Observation only; `appendEvent` is the write chokepoint

**Choice:** Train events go through `appendEvent` (redaction, sink, write-health, non-fatal I/O). They do not authorize merge or advance. Notify failure does not change train state. Tests inject run-store/log/wave fakes.

**Why:** Same delivery contract as every other generic run-store producer. No parallel logger.

## Risks / Trade-offs

- **[Risk] `initRunDir` requires `issue: number` today.** → Mitigation: extend run identity in the same change; tests fail if a train `run.json` looks like an advance run for one issue.
- **[Risk] Process crash before `run_complete` hangs until-terminal follow.** → Same as advance. Mitigation: write `run_complete` on every normal exit path after init, including STOP/error. Crash remains interrupt-only.
- **[Risk] Mixing train and advance IDs in one `pipeline logs` listing.** → Acceptable; `train-` prefix distinguishes them.
- **[Risk] Material-filter one-liners for new types are empty until formatters exist.** → Implementation MUST add formatters in the same change as the kind list; drift-guard covers kinds, unit tests cover a sample one-liner per type.
- **[Trade-off] Stderr handoff vs stdout.** Hosts that only read `--json` stdout still get `run_id` at the end; mid-flight follow requires reading stderr or the run directory. Document both.

## Migration Plan

- Additive. Old train invocations have no train-level store; new ones do.
- `train_status.schema_version` stays `1` with additive `run_id`.
- Existing `loop_run_handoff` stderr lines remain.
- Rollback: revert the change; hosts fall back to stdout (no durable train file).

## Open Questions

None that change the specs. `train --dry-run` stays a separate issue.
