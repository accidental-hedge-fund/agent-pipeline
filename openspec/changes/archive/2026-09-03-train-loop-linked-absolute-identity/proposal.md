## Why

#1301 required `train_loop_linked` to use the exact child `onRunReady` identity: a nonempty run id plus a confirmed absolute `events.jsonl` path. PR #1414 (`82800fcc`) still publishes a link when `eventsPath` is missing or relative, and it keys duplicate suppression on run id only. A host can receive a non-followable link. A later handoff with the same run id and a different path is dropped while `events_coverage` stays healthy.

## What Changes

- Publish `train_loop_linked` only when the handoff has a nonempty run id and a nonempty absolute events path. Omit the event when the path is missing, empty, or not absolute. Do not invent a path.
- Deduplicate on that full identity (`loop_run_id` plus absolute path). A later handoff with the same pair SHALL NOT append a second event.
- When a later handoff disagrees on path or run id for an already published live link, keep the first event, do not append, and set `events_coverage` to `degraded`.
- Keep `onLoopReady` as the sole append site. Do not change advance, merge, retry, exit status, train scheduling, merge authority, or the `train --json` stdout object kind.

**BREAKING:** none. The change tightens observational live-link admission. It does not change train mutations.

## Capabilities

### New Capabilities

- None. This change closes residual #1301 live-link identity gaps. It does not add a collector, event type, or CLI verb.

### Modified Capabilities

- `train-event-stream`: `train_loop_linked` requires a nonempty run id and a nonempty absolute events path. Duplicate suppression uses that full identity. A conflicting later handoff keeps the first link and degrades `events_coverage`. Injected regressions fail against today's `publishLiveLoop` / run-id-only `linkedLoopIds` behavior.

## Impact

- **Class vs site:** the sites are `publishLiveLoop` appending without an absolute path, and `linkedLoopIds` keyed on run id only. The class is: a followable live link is the exact child `onRunReady` pair. Incomplete or conflicting identities MUST NOT be published as live links. The next missing-path or same-id-different-path handoff follows this admission. It does not need a new mole issue.
- **Reuse first:** keep `publishLiveLoop`, `liveLoopByWave`, and additive `events_coverage`. Use Node `path.isAbsolute` for the absolute-path check. Do not add a new identity type, collector, or event.
- **Train command:** `core/scripts/stages/train.ts` `publishLiveLoop` is the omit/append/dedup/conflict gate. Production `advanceWaveThroughLoop` invokes `onLoopReady` only when that same pair is confirmed.
- **Tests:** inject train/wave seams in `core/test/train.test.ts`. No live network, git, or subprocess. Bite missing path, relative path, valid absolute append-once, and same-id-different-path degrade.
- **Does not:** reopen train identity allocation or merge-proof disposition. Does not add a collector or a new event type. Does not change review-policy so `blocking: true` inside an `approve` verdict becomes a hard gate.

## Acceptance criteria

- [ ] A handoff with a run id and no events path does not append `train_loop_linked`.
- [ ] A handoff with a relative events path does not append `train_loop_linked`.
- [ ] A valid absolute-path handoff still appends once from awaited `onLoopReady`.
- [ ] A later handoff with the same run id and a different absolute path does not replace the first link and sets `events_coverage` to `degraded`.
- [ ] Injected regressions fail against today's `publishLiveLoop` / `linkedLoopIds` behavior.
- [ ] Tests inject train/wave seams; no live network, git, or subprocess.
- [ ] No train scheduling, merge-authority, or `--json` stdout object-kind changes.
- [ ] After `core/` edits, `node scripts/build.mjs` and `npm run ci` pass.
