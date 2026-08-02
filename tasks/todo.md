# #777 Universal stage-output contract layer

## Plan
- [x] stage-output-contract.ts: registry, validators, format-repair, fixture hook
- [x] Register plan-revision.ack@1, openspec.change-singular@1, review.verdict@1
- [x] Migrate planning plan-revision + OpenSpec singularity to shared repair + harness-contract
- [x] Wire review delegated unparseable path through shared repair
- [x] Golden fixtures + tests + drift guards
- [x] plugin regenerate + npm run ci + commit

## Review
- Central `core/scripts/stage-output-contract.ts` owns versioned registry + shared format-repair.
- Plan-revision / OpenSpec authoring / delegated review use the same repair budget (1).
- Terminal pure shape failure emits `pipeline/stage-diagnostic@1` reason `harness-contract`.
- Named provider shapes are golden fixtures only; extension fixture hook present.
- Follow-ups for shipcheck/design/auto-merge listed and drift-pinned.
- `npm run ci` green.
