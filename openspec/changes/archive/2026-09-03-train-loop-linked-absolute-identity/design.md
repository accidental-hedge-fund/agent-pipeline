## Context

See `proposal.md` for why. Current law and code after #1301 / PR #1414 (`82800fcc`):

- Living `train-event-stream` already keys `train_loop_linked` to `loop_run_id` plus absolute events path. It already degrades `events_coverage` on a mismatched later wave result.
- `runTrain`'s live-link callback (`publishLiveLoop` in `core/scripts/stages/train.ts`) still appends when `eventsPath` is missing: it spreads `...(loopRun.eventsPath ? { events: loopRun.eventsPath } : {})`.
- Duplicate suppression uses `linkedLoopIds: Set<string>` of run ids only. A later `onLoopReady` with the same run id and a different path returns early. Coverage stays healthy.
- Production `advanceWaveThroughLoop` calls `onLoopReady` whenever `ctx.runId` is nonempty. `ctx.events` may be absent. `out.loopRun` can then carry a run id without an absolute path.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The sites are one optional-path append and one run-id-only Set. The class is: a followable live link is the exact child `onRunReady` pair (nonempty run id plus nonempty absolute events path). Incomplete identities are omitted. Conflicting later identities keep the first link and degrade coverage.
2. **Shared surfaces.** Existing `onLoopReady` append site, `liveLoopByWave` confirmation, additive `events_coverage`, Node `path.isAbsolute`. Not a new collector, identity type, or event.
3. **Next identical fault.** The next missing-path or relative-path handoff is omitted at both the producer and the append gate. The next same-id different-path handoff keeps the first link and degrades coverage. No new mole issue.

## Goals / Non-Goals

**Goals:**

- Admit `train_loop_linked` only for a nonempty run id and a nonempty absolute events path.
- Deduplicate on that pair. Degrade coverage on a confirmed identity conflict. Do not degrade on an omitted incomplete handoff.
- Keep the existing awaited `onLoopReady` sole append site.

**Non-Goals:**

- Reopening exclusive train identity allocation or merge-proof disposition.
- A new helper module, identity type, collector, or event type.
- Changing review-policy so `blocking: true` inside an `approve` verdict becomes a hard gate.
- Changing train scheduling, merge authority, retry, exit status, or `--json` stdout object kind.

## Decisions

### 1. Gate admission at the existing append site; withhold incomplete producer handoffs

**Choice:** Keep `publishLiveLoop` as the sole `train_loop_linked` append site. Require a trimmed nonempty run id and a nonempty path that `path.isAbsolute` accepts before append. Production `advanceWaveThroughLoop` SHALL invoke `onLoopReady` only when that same pair is confirmed. Do not add a shared identity helper. `train.ts` already imports `node:path` (`join`); add `isAbsolute` there. `pipeline.ts` already uses `path.isAbsolute` for other admission checks.

**Why:** First holding rung after reading the touched code. The omit/append decision already lives in `publishLiveLoop`. Node `path.isAbsolute` is stdlib and already used in this repo. A new `LinkedLoopIdentity` type or helper would be an unrequested layer. Gating the producer as well is the class fix: the next composer that consumes `onLoopReady` does not receive a non-followable pair.

**Alternatives considered:**

- Gate only in `publishLiveLoop` and keep calling `onLoopReady` with a run id alone → rejected as site-only. The issue names the producer as a cause.
- Resolve a relative path against the repo or state home → rejected. #1301 forbids inventing an absolute path.
- Degrade coverage on an incomplete first handoff → rejected. Omit is not a confirmed conflict. Coverage stays `ok` or omitted.

### 2. Reuse the existing Set/Map pair; key published links on full identity

**Choice:** Keep `liveLoopByWave` for per-wave confirmation. Change `linkedLoopIds` from a run-id `Set` to a run-id → absolute-path `Map` (or a Set of full-identity keys plus a lookup of the published path). On a valid later handoff: same pair is a no-op; a different path or run id for an already published live link does not append and sets `events_coverage` to `degraded`. A later wave with a new run id still appends once. Wave-result `loopRun` stays a confirm/conflict site, not an append site.

**Why:** First holding rung. The structures already exist next to the append callback. The bug is the key, not a missing layer. Per-wave first-link plus global once-per-identity matches "emit each live linkage once" without treating a later wave's new child as a conflict.

**Alternatives considered:**

- Keep run-id keys and only add an `isAbsolute` guard → rejected. That still silent-drops same-id different-path and leaves coverage healthy.
- Treat any later different run id as a global conflict → rejected. Multi-wave trains publish one link per child loop.
- Append a second event tagged `degraded` → rejected. Keep the first followable link. Do not add an event type.

### 3. Tests bite today's append and today's keys before the fix

**Choice:** Add injected `runTrain` / `advanceWave` tests in `core/test/train.test.ts` next to the existing #1301 live-link cases. They MUST fail against current `publishLiveLoop` / `linkedLoopIds` if a missing or relative path still appends, or if same-id different-path is dropped without `events_coverage === "degraded"`. Keep the existing live-absolute append-once test green.

**Why:** Bug-fix law: a regression that would have caught the PR #1414 gaps. The fixture already calls `ctx.onLoopReady` with `{ runId, eventsPath }`. No new test harness.

**Alternatives considered:**

- Source-scan only (assert `path.isAbsolute` appears in `train.ts`) → rejected as a non-behavioral stand-in. Keep a source-scan for awaited `onLoopReady` if one already exists; do not substitute it for the injected append tests.

## Risks / Trade-offs

- **[Risk] Test fakes pass a POSIX absolute path while `path.isAbsolute` is the Node host rule.** → Mitigation: existing #1301 fixtures already use `/abs/E`. New relative fixture uses `runs/abc/events.jsonl`, which is not absolute on this host.
- **[Risk] Withholding `onLoopReady` on incomplete producer handoffs changes `out.loopRun`.** → Mitigation: wave-result `loopRun` is observational. Tests already treat missing `onLoopReady` as "no live store confirmed." Do not change advance outcomes.
- **[Trade-off] Two inline `path.isAbsolute` checks instead of one helper.** Acceptable: the ladder forbids an unrequested helper for a few lines. The two sites already exist.

## Migration Plan

- Additive for hosts: incomplete links disappear from the stream; conflicting same-id paths degrade coverage instead of looking healthy.
- Rollback: revert the change. Hosts can again receive a `train_loop_linked` without `events`, and same-id different-path stays a silent drop.

## Open Questions

None that change the specs.
