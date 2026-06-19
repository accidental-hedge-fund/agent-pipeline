# bounded-auto-loop

Opt-in bounded auto-loop mode (#149): when enabled, the advance loop auto-continues through recoverable, pipeline-owned recovery cycles (flaky-test rerun, stale-branch rebase, reviewer/shipcheck fix) within explicit round + wall-clock budgets, records why it continued and the budget remaining, then parks at `needs-human` with an evidence-backed handoff. Default-disabled; never merges/deploys/publishes, never bypasses human checkpoints, and integrates review-loop-recurrence (#133) so a finding can't churn forever.
