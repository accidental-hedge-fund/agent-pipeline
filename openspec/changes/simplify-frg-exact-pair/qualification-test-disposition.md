## Installed-qualification regression disposition

Package 2 keeps product invariants in ordinary deterministic CI and does not
carry qualification choreography into the exact-pair release verifier.

| Former qualification subject | Disposition | Normal deterministic owner |
|---|---|---|
| Public `drive`, `single`, and `loop` admission | Retained | `fault-recovery-installed-cli.test.ts`, command and loop suites |
| Logical-operation accounting and lifecycle ownership | Retained | `fault-recovery-matrix.test.ts`, `loop-supervisor.test.ts` |
| Exact-source launcher and candidate preparation | Retained | `candidate-engine-readiness.test.ts`, `exact-candidate-frg.test.ts` |
| Process exception, rejection, exit, signal, timeout, malformed output, and auth classification | Retained | fault-recovery matrix, host-conformance, and recovery suites |
| Ownerless-terminal and false-human refusal | Retained | recovery lifecycle and escalation-disposition suites |
| Exact candidate test/module inventory | Retained and corrected | `fault-recovery-installed-cli.test.ts`; inventory comes from `git ls-tree <candidate>` |
| Release matrix artifact construction | Retired | Choreography only; not accepted by the exact-pair verifier |
| Scenario score and threshold rows | Retired | Choreography only; ordinary behavior remains covered by its owning suites |
| Producer HMAC / attestation ordering | Retired from package-2 verifier | Historical caller coverage remains only until package 4 |
| Prepare → score → attest → re-observe ordering | Retired from package-2 verifier | Historical caller coverage remains only until package 4 |

The external installed-launcher smoke may remain while legacy callers exist,
but it is not a release prerequisite and is not an input to
`verifyReleasePathExactCandidateFrg`.
