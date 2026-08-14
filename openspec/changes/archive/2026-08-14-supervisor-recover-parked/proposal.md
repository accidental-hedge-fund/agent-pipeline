## Why

When review/fix hits the round ceiling or pre-merge residual delta review still blocks at the **current** head, the item parks (`blocked` / `pipeline:needs-human`) and stays dead. Train, Tugboat, and outer hosts STOP and wait for a human. The only senior lever today is manual `pipeline override` then `pipeline single` — nothing invokes it. Factory dogfood **#599** (v1.39.0) parked after three pre-merge residual cycles with a live **CRITICAL** security residual; silent LGTM or host-improvised override is not acceptable. This change adds one bounded, audited supervisor reflow command so stale/DNR/below-high parks can re-enter advance once, while HIGH/CRITICAL/security/authority parks stay human.

## What Changes

- Add **`pipeline recover-parked <n>`** (name fixed unless implementation discovers a registry collision; behavior is authoritative): one supervisor pass per park fingerprint that re-evaluates findings at live PR HEAD, optionally overrides only eligible keys through the existing audited `pipeline override` path, optionally runs at most one extra implementer fix round for remaining valid non-overridable defects, then re-enters `pipeline single` / continue train for the same issue.
- **Never** auto-override HIGH, CRITICAL, `category: security`, or `human-decision-required` / missing-authority. Severity and category come **only** from the structured review record — the senior pass MUST NOT reclassify CRITICAL as a nit to unlock override.
- **Deterministic first:** existing engine recover (scratch unlink, stale-SHA re-review, leftover `blocked` after HEAD moved) runs before any override or extra fix. If that clears the park, do not spend the supervisor budget and do not override.
- **Budget:** one supervisor pass per `(issue, stage, sorted blocking override-keys)` fingerprint. Same keys after a new commit do not grant another pass. Second park with the same fingerprint → human (existing punch list + manual override).
- **Fix ≠ override:** at most one extra implementer round MAY code-fix still-valid HIGH/CRITICAL; it MUST NOT override those keys. If they remain at the new HEAD → keep park + human.
- **Train / Tugboat / thin hosts:** on `needs-human` / leftover `blocked` after deterministic resume, call this CLI **once** for the fingerprint; if still parked → today's STOP + notify. Hosts MUST NOT invent `pipeline override` or drop `blocked`.
- Thin compose only — no MessagingPort, no grant factory, no second state machine, no auto-merge.
- Does **not** replace #1020/#1025 engine-scratch / stale-SHA paths; those stay deterministic and first.

## Capabilities

### New Capabilities

- `supervisor-recover-parked`: Bounded one-pass post-park reflow command and pure classification rules (severity-from-record, fingerprint budget, deterministic-first, fix-vs-override, audited override payloads, re-enter single/train without backlog restart).

### Modified Capabilities

- `command-registry`: Register `recover-parked` with explicit flag allowlist and documentation metadata.
- `namespaced-command-surface`: Expose `pipeline:recover-parked` on Claude/Codex host discovery; forward only to the CLI.
- `integrated-train-mode`: On park / leftover blocked after deterministic resume, invoke `recover-parked` once per fingerprint before terminal STOP/hold; never invent override in train.
- `ship-path-autonomy-doctrine`: Outer supervisors (Tugboat/Hermes/host SKILL) may only invoke this CLI (or no-op + STOP); must not invent override or drop blocked labels.

## Acceptance criteria

- [ ] CLI recovers a fixture park where residual keys are stale/DNR or below-high: audited override records for those keys and `pipeline single` (or equivalent re-enter) resumes the same issue without restarting from backlog.
- [ ] CLI leaves a fixture park with still-valid HIGH or CRITICAL findings parked (`blocked` / `needs-human`); no override disposition is recorded for those keys.
- [ ] Fixture: structured CRITICAL (or HIGH / `category: security`) cannot be overridden even when classifier prose claims "nit" or stale — severity/category from the review record alone decide override eligibility.
- [ ] Fixture: after a new commit that leaves the same sorted blocking override-keys, a second `recover-parked` does not spend another supervisor pass (no second override batch / no second extra fix from the supervisor budget).
- [ ] Fixture: scratch-only or stale-SHA park is cleared by the deterministic path without recording an override and without consuming the supervisor pass budget.
- [ ] Extra fix round may produce a commit that addresses still-valid HIGH/CRITICAL; any attempt to `override` those keys from the supervisor path is refused; if findings remain at the new HEAD the item stays parked for human.
- [ ] Second identical park fingerprint does not spend another supervisor pass (idempotent refuse / no-op with evidence).
- [ ] Train (and Tugboat/outer host composition that uses train or the same park hook) invokes this CLI once on `needs-human` / leftover blocked after deterministic resume, then STOPs if still parked — no host-invented override or silent label drop.
- [ ] Override payloads cite the finding key from the review record and a one-line evidence reason (`stale` / `DNR` / `below-high` class); keyless or prose-only dispositions are refused.
- [ ] Unit tests use injected deps only (no real network/git/subprocess); after any `core/` edits, `plugin/` is regenerated; `openspec validate supervisor-recover-parked` and `npm run ci` are green.

## Impact

- **CLI:** new `recover-parked` keyword in `pipeline.ts` / command registry; optional host `pipeline:recover-parked` packaging.
- **Engine:** pure classification over structured review findings at live HEAD; fingerprint ledger (issue + stage + sorted keys) for one-pass budget; composition of existing deterministic recover (`engine-scratch-recover`, `stale-blocked-rereview`) before senior path; call-through to existing audited `pipeline override` / governed override record path; optional single implementer fix round; re-enter `single` / train continuation for same issue.
- **Train / ship path:** park hook after deterministic resume attempts; docs/supervisor guidance update for host-only-CLI rule.
- **Tests:** fixture parks for stale/below-high, CRITICAL refuse, fingerprint budget, deterministic-first, fix-not-override; train hook once-then-STOP.
- **Related (compose, do not re-own):** #233 `demote_and_advance` (review ceiling only — not post-park reflow); #647 human-question handoff (authority stays parked); #1020/#1025 deterministic scratch/stale-SHA; existing `pipeline override` + `override-auto-resume` + `governed-overrides` as disposition primitive; #599 dogfood residual must remain non-auto-overridden while CRITICAL.
- **Non-goals:** auto-advance CRITICAL residuals; Hermes/Buzz ship brain; threshold→general LLM for any block; host SKILL improvising override; LLM-assigned severity that disagrees with the review record; MessagingPort / grant factory / second state machine; merge inside advance/loop.
