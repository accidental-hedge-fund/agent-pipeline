# Roadmap

Single source of truth for the execution order of the open backlog. Last updated 2026-06-07.

**Goal driving the order:** make the pipeline robust enough to **develop itself**, then continue by value.
**Self-dev is ready after #13 + #15.**

## Execution order

1. **#13** — Configurable pipeline steps *(foundation — the config surface everything plugs into)*
2. **#15** — Test/build gate + bounded fix loop *(unblocks trustworthy self-dev)*
3. **#12** — Eval gate
4. **#16** — SHA-keyed review verdicts + re-review when HEAD moves
5. **#26** — Incorporate human comments on the plan into revision
6. **#17** — Review severity policy + audited overrides
7. **#22** — Differentiated failure handling / escalation taxonomy
8. **#23** — Optional human approval checkpoints
9. **#19 + #25** — Compounding context (closed-loop learning + research-grounded planning) — build together
10. **#18** — Multiple review critics + quorum aggregation
11. **#21** — Optional sandboxed execution *(largest; last)*

## Parallel lane (isolated files — pick up anytime)

- **#9** — Installer installs/updates dependencies *(after the codex-plugin-cc spike below)*
- **#20** — Commit traceability trailers

## Spikes (do just before their dependent)

- Identify what `openai/codex-plugin-cc` is → before **#9**
- De-duplicate `planning.ts`'s freeform + OpenSpec flows → before **#15**
- Compounding-context design (storage, what feeds planning/review) → before **#19/#25**

## Decisions

- **#24** — The pipeline never extends past `ready-to-deploy` (no auto-merge / preview / soak-obs / canary / rollback). **Closed.** Revisit only if that changes.

## Backlog hygiene

- **#14, #27** — tracking/research epics; keep as trackers or close (their children are filed).
- Rough issues (**#15–#26**) need a `/pm` spec pass before building. Decision-complete today: **#9, #12, #13**.

## Scoring (reference)

`Priority = (Impact × Confidence × Ease) + Risk reduction + Dependency leverage` (1–5 each). Execution order is value-ranked, overridden only by: **#13 first** (foundation), **#15 promoted** (self-dev goal), **spikes before dependents**, **#17 before #18**.

| # | Score | | # | Score |
|---|---|---|---|---|
| 13 | 82 | | 9 | 40 |
| 12 | 66 | | 22 | 33 |
| 16 | 55 | | 23 | 31 |
| 26 | 51 | | 19 | 30 |
| 15 | 48\* | | 25 | 30 |
| 17 | 42 | | 20 | 26 |
| | | | 18 | 23 |
| | | | 21 | 11 |

\* #15 is value-ranked 5th but **executed 2nd** to unblock self-dev.
