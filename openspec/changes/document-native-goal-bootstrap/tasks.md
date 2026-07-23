## 1. Author the Claude host bootstrap doc

- [x] 1.1 In `hosts/claude/SKILL.md`, add a bootstrap subsection near the
      `/pipeline:loop` documentation showing the operator running `/goal` and
      then `/pipeline:loop …` for a durable run, in that order.
- [x] 1.2 State the non-claims: the skill does not detect host `/goal` state,
      does not itself invoke/re-enter `/goal`, and does not control the native
      session lifecycle.
- [x] 1.3 State that native completion is a host/user action taken after the
      durable run reports its own done and reconciliation conditions, and that
      the skill neither ends the `/goal` session nor merges.

## 2. Author the Codex host bootstrap doc

- [x] 2.1 In `hosts/codex/SKILL.md`, add the symmetric bootstrap subsection
      showing `/goal` then `$pipeline:loop …`, in that order.
- [x] 2.2 Mirror the same non-claim and host-owned-completion statements, noting
      Codex requires the `available` operator attestation (no documented native
      `/goal` floor) without re-specifying the probe's detection logic.

## 3. Add the drift-guard test

- [x] 3.1 Add a co-located test under `core/test/` that reads both authored host
      SKILL documents and asserts, per host: the `/goal` → correct-token
      ordering, and each of the four required statements (no state detection, no
      recursive invocation, no lifecycle control, host-owned completion).
- [x] 3.2 Add the symmetry assertion: neither host carries the other's loop token
      in its bootstrap step, and both carry the same non-claim set.
- [x] 3.3 The test performs no network, git, or subprocess call.
- [x] 3.4 Prove the test bites: temporarily remove the bootstrap block and
      confirm the test fails, then restore.

## 4. Regenerate mirror and gate

- [x] 4.1 Run `node scripts/build.mjs` to regenerate `plugin/` and commit the
      mirror in the same change.
- [x] 4.2 Run `npm run ci` from the repo root and confirm it is green
      (`ci:core`, `build.mjs --check`, install-smoke, `openspec validate --all`).

## 5. Validate the change

- [x] 5.1 Run `openspec validate document-native-goal-bootstrap` and fix any
      structural error until it passes.
