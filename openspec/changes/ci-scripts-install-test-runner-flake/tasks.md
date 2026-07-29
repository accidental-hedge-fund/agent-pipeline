## 1. Isolate and confirm the flake surface

- [ ] 1.1 Record current scripts-test entry points (`package.json` `ci:scripts`, scripts half
      of `npm test`, any docs that quote the command) and Node version used in
      `.github/workflows/ci.yml`.
- [ ] 1.2 Run a short isolation matrix on the same Node major as CI: multi-file default
      `node --test scripts/*.test.mjs`, per-file top-level `node --test <file>`, optional
      `--test-isolation=none` / `--test-concurrency=1`, and `install.test.mjs` alone — note
      whether the deserialize error is multi-file-parent-only or can appear on a single file.
- [ ] 1.3 Write the root-cause (or best-supported hypothesis) bullet for the PR description
      before landing the fix.

## 2. Structural runner invocation

- [ ] 2.1 Implement the preferred structural approach: a small deterministic wrapper
      (e.g. `scripts/run-scripts-tests.mjs`) that discovers `scripts/*.test.mjs` in sorted
      order and runs each as its own top-level `node --test <file>` process with inherited
      stdio, aggregating non-zero exits — unless task 1.2 proves a simpler flag-only form
      fully avoids the deserialize path without cross-file state risk.
- [ ] 2.2 Wire root `package.json` `ci:scripts` to the structural entry point.
- [ ] 2.3 Wire the scripts half of `npm test` to the same entry point so local and CI do not
      diverge on the flake path.
- [ ] 2.4 If a flag-only approach is chosen instead of a wrapper, pin the exact flags in
      `package.json` and document why they remove the IPC path.

## 3. Regression coverage

- [ ] 3.1 Add a regression test that fails if `ci:scripts` is restored to the abandoned
      single-parent multi-file form `node --test scripts/*.test.mjs` (or the specific prior
      form identified as flake-prone in task 1).
- [ ] 3.2 Assert the structural entry point remains wired (wrapper path and/or isolation
      flags) and is not a no-op.
- [ ] 3.3 Confirm a deliberate product assertion failure in a scripts test still fails
      `ci:scripts` with normal test-runner output (manual or automated smoke).

## 4. Verification and docs

- [ ] 4.1 Run `npm run ci:scripts` and `npm run ci` from the repo root; fix until green.
- [ ] 4.2 Ensure `openspec validate ci-scripts-install-test-runner-flake` (and workspace
      validation via `ci:openspec`) pass.
- [ ] 4.3 Put the root-cause note and cross-link (pre-merge infra-flake recovery is out of
      scope / tracked separately post-#181) in the PR description.
- [ ] 4.4 Confirm no pre-merge gate / review-rigor demotion and no product-test skips were
      introduced to “fix” the flake.
