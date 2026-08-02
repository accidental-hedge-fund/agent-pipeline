## 1. Write-health core in run-store

- [ ] 1.1 Define the run-scoped write-health record shape (failure count, last error, last event type, worst criticality, exclusive-fallback flags) and read/update helpers behind `RunStoreDeps`.
- [ ] 1.2 Extend `appendEvent` (or a thin wrapper) with criticality classification (`control-critical` vs `best-effort`) and update write-health on durable-delivery failure without throwing.
- [ ] 1.3 Implement exclusive-sink local fallback: on exclusive mode sink failure, attempt local `events.jsonl` write; record sink failure in write-health; return true only when local fallback (or sink) succeeds.
- [ ] 1.4 Decide optional post-append fsync: implement behind deps if cost-acceptable, or document residual durability gap vs loop store; fsync failure follows non-fatal + write-health contract.
- [ ] 1.5 Include write-health in `finalizeRun` / `summary.json` enrichment.

## 2. Operator surfaces

- [ ] 2.1 Surface elevated write-health on `pipeline <issue> --status` prose and additive `--status --json` field without bumping status `schema_version`.
- [ ] 2.2 Surface write-health on `pipeline summary` human output from finalized bundle / run dir.
- [ ] 2.3 Add doctor run-store write-path + bounded recent write-health check with remediation text and non-zero exit on failure.
- [ ] 2.4 Document exclusive-sink durability risk and local-fallback behavior in config help / generated config reference text for `event_sink.mode`.

## 3. Control-critical call sites and recovery fail-safe

- [ ] 3.1 Classify control-critical producers (blocker_set/cleared, stage-diagnostic evidence, recovery claim/result, run/loop terminal) when appending events.
- [ ] 3.2 Ensure recovery/restart paths treat missing control-critical evidence + elevated write-health as fail-safe (engine-owned defect / unknown path), never unrelated class, human hold from absence, or false `recovered`.
- [ ] 3.3 Confirm best-effort telemetry failures still do not block stage advancement or flip labels.

## 4. Tests

- [ ] 4.1 Unit tests: `appendEvent` returns false → write-health updated; healthy path unchanged (injectable `RunStoreDeps`).
- [ ] 4.2 Unit tests: exclusive sink failure triggers local fallback; dual failure returns false and elevates write-health.
- [ ] 4.3 Unit tests: control-critical vs best-effort criticality on write-health; partial-tail `readEvents` + restart read of write-health.
- [ ] 4.4 Unit tests: status JSON/prose, summary finalize, and doctor check surface elevated write-health; doctor passes when healthy.
- [ ] 4.5 Unit tests: recovery consumer does not misclassify or mark recovered when control-critical records are missing after write-health failure.

## 5. Delivery

- [ ] 5.1 Run `openspec validate run-store-event-append-visibility` (and `openspec validate --all` as needed) and fix structural issues.
- [ ] 5.2 After core edits: `node scripts/build.mjs` and commit regenerated `plugin/` with core.
- [ ] 5.3 Run `npm run ci` from repo root until green.
