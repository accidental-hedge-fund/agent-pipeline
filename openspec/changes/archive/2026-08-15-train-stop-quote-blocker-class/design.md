## Context

See `proposal.md` for motivation and acceptance criteria.

Today production train advances a base-eligible frontier via one multi-item loop wave (`advanceWaveThroughLoop`). When the loop ends without a clean parked label state, per-item outcomes fall through `classifyTrainAdvanceLabels(..., exit)` and can become **only** `pipeline advance exited with code N` (historical ship lines said `pipeline single exited with code N`). Loop `events.jsonl` already records `loop_run_stopped.reason` and `loop_item_blocked.class`, but train does not lift those fields into `train_status.blocker` / item `error`. Tugboat’s `failure_detail` correctly prefers `train.json.blocker` when present (#997); empty structure in the blocker yields exit-only Buzz lines.

Constraints that shape the approach:

- Production path is multi-item loop advance wave, not N×`single` (existing `integrated-train-mode` law).
- Advance / loop never merge; exit codes stay non-zero on failure.
- Unit tests inject deps — no real network, git, or subprocess.
- Ship-path autonomy: **class over site** — fix the shared train STOP / advance-outcome classification surface so every train consumer (CLI, Tugboat, status) benefits; do not put diagnosis only in Tugboat shell string munging.
- Surgical coexistence: ordinary product review findings stay finding-scoped; this change is engine dogfood STOP-surface law.

## Goals / Non-Goals

**Goals:**

- Define a single enrichment rule: structured loop evidence → human-visible train STOP / item error / blocker string.
- Preserve raw exit code as last resort when no structured evidence exists.
- Keep Tugboat thin: it continues to copy train blocker text; no second event parser in the host composer unless a pure helper already shared is reused.

**Non-Goals:**

- Recovering or reclassifying the underlying parks.
- Changing loop event schemas or inventing new stop reasons.
- Changing train exit codes or complete/incomplete semantics beyond the blocker **text**.
- Building a full evidence-bundle dump into the notify line (first useful structured fields only; keep lines operator-scannable).

## Decisions

### D1 — Enrich at train advance-outcome classification, not only in Tugboat

**Decision:** When building a non-ok advance outcome or train STOP blocker for an advance-wave failure, train (shared helper used by the production wave path) SHALL read the just-finished loop run’s structured events (or an injected equivalent) and compose the error string. Tugboat keeps reading the sidecar.

**Rationale:** Issue acceptance is train error / notify contains the class. Notify already reads train blocker. Fixing only Tugboat leaves `pipeline train --json` and non-Tugboat supervisors still exit-only.

**Alternatives considered:**

- Tugboat-only stderr scrape → rejected (site mole; train JSON still useless).
- Change loop to always set `needs-human` labels so classify maps to park terminals → rejected (orthogonal; not always true for hard loop stops; does not quote `reason`/`class`).

### D2 — Priority order for evidence fields

**Decision:** Compose the human-visible reason from present fields in this order (include later fields only when they add information not already covered):

1. Last `loop_run_stopped.reason` (e.g. `supervisor_no_progress`, `dependency_deadlock`, `recovery_exhausted` when emitted as stop reason).
2. Last `loop_item_blocked.class` + issue identity.
3. Last blocker comment first line and/or `blocker_kind` when available from the attempt’s blocker evidence without inventing text.
4. Raw exit code / engine error message.

**Rationale:** Matches issue required order; gives operators the class they already use in loop diagnosis.

**Alternatives considered:**

- Always dump full events tail → rejected (noisy notify).
- Prefer item-blocked over run-stopped always → rejected; run-stop is the terminal class for whole-wave STOPs like no-progress / deadlock.

### D3 — No invented class when events are missing

**Decision:** If the attempt has no readable loop events (or injectable evidence is empty), the string SHALL include the exit code or engine failure message and SHALL NOT synthesize a stop class name.

**Rationale:** Explicit acceptance criterion; fail closed on diagnosis honesty.

### D4 — Wire evidence through deps / pure helper for tests

**Decision:** Extract (or extend) a pure composition helper such as “given exit code + optional last stop reason + optional last blocked class/issue + optional blocker_kind/comment → string”, and feed it from the advance-wave path with an injectable “read last loop evidence for this run” seam. Unit tests assert composition and end-to-end train status.blocker without real loop stores when possible.

**Rationale:** Repo testing convention (`deps` seams); proves the regression that exit-only was the only visible reason.

### D5 — Independent-peer hold vs whole-train STOP

**Decision:** Per-item non-ok outcomes that **hold** an item (without aborting independent peers) SHALL use the same enrichment for that item’s `error` field. When the train eventually STOPs because no schedulable work remains, aggregate / blocker text SHALL still name held issues with their enriched reasons (existing “held items remain…” patterns continue, with richer per-item text).

**Rationale:** Issue’s dogfood lines were whole-train STOP; peer-hold must not reintroduce exit-only on the item that actually failed.

### D6 — Do not reverse production multi-item loop path

**Decision:** Enrichment applies to the production `advanceWave` / loop path. Legacy `advanceIssue` / single wrappers used only by thin adapters or tests MAY share the pure string helper when they have evidence; production MUST NOT switch back to N×`single` solely to attach this message.

**Rationale:** Existing train composition law (#1023 / integrated-train-mode).

## Risks / Trade-offs

- **[Risk] Loop run directory / events path not known to train after wave** → **Mitigation:** Use the advance-wave / loop engine result’s run id path if already returned; if not, extend the injectable result with last-run evidence summary only (minimal field surface), not a full second store client in train.
- **[Risk] Malformed or partial JSONL** → **Mitigation:** Best-effort scan; missing fields fall through the priority list; never invent; still attach exit code.
- **[Risk] Overlong notify lines** → **Mitigation:** Prefer compact tokens (reason, class, issue number, short first line); truncate comment first line if needed; do not paste full review dumps.
- **[Risk] Duplicate wording in Tugboat stderr preference paths** → **Mitigation:** Keep existing “prefer informative stderr over generic exit” heuristics; enriched train blocker should already be informative so sidecar wins cleanly.

## Migration Plan

- Land as ordinary PR under #1074; no config flag.
- After merge, next ship STOP lines carry class when loop events exist; operators need no install step beyond engine promote of the version that includes the fix.
- Rollback: revert the enrichment helper; exit-only text returns (prior behavior).

## Open Questions

None that block specs or tasks. Implement may choose exact helper placement (`pipeline.ts` vs small pure module next to train) without changing the requirement text.
