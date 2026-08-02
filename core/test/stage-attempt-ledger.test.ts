// #759: stage-attempt ledger — claim-before-side-effect, restart after started,
// double-claim rejection, supersession on HEAD movement, legacy migration.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimAndPersistStageAttempt,
  claimStageAttempt,
  completeAndPersistStageAttempt,
  completeStageAttempt,
  emptyStageAttemptLedger,
  hasAttempted,
  hydrateStageAttemptLedger,
  migrateLegacyCiMarkersToAttempts,
  persistStageAttemptLedger,
  projectCiRecoveryFromLedger,
  stageAttemptId,
  supersedeStageAttempt,
  syncCiProjectionIntoLedger,
  type StageAttemptLedgerDeps,
} from "../scripts/stage-attempt-ledger.ts";

function memoryDeps(seed: Map<string, string> = new Map()): {
  deps: StageAttemptLedgerDeps;
  files: Map<string, string>;
} {
  const files = seed;
  return {
    files,
    deps: {
      now: () => new Date("2026-08-02T12:00:00.000Z"),
      readText: (p) => (files.has(p) ? files.get(p)! : null),
      writeText: (p, c) => {
        files.set(p, c);
      },
      mkdirp: () => {},
    },
  };
}

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RUN = "/tmp/fake-run-759";

test("stageAttemptId is stable for (headSha, action)", () => {
  const a = stageAttemptId({ headSha: HEAD, action: "ci_rerun" });
  const b = stageAttemptId({ headSha: HEAD, action: "ci_rerun" });
  const c = stageAttemptId({ headSha: HEAD2, action: "ci_rerun" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("claim before side effect persists started status and charges budget", () => {
  const ledger = emptyStageAttemptLedger();
  const claimed = claimStageAttempt(ledger, {
    headSha: HEAD,
    action: "ci_rebase",
    typedReason: "definitive_ci_failure",
    budgetBefore: 1,
  });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;
  assert.equal(claimed.created, true);
  assert.equal(claimed.attempt.status, "started");
  assert.equal(claimed.attempt.outcome, "started");
  assert.equal(claimed.attempt.budget_remaining, 0);
  assert.equal(claimed.attempt.idempotency_key, claimed.attempt.attempt_id);
  assert.equal(claimed.attempt.head_sha, HEAD);
  assert.ok(hasAttempted(ledger, HEAD, "ci_rebase"));
});

test("restart after started rehydrates without free replay / double charge", () => {
  const { deps, files } = memoryDeps();
  let ledger = emptyStageAttemptLedger();
  const first = claimAndPersistStageAttempt(
    RUN,
    ledger,
    { headSha: HEAD, action: "ci_rerun", typedReason: "infra_flake" },
    deps,
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.created, true);
  assert.equal(first.attempt.status, "started");

  // Simulate process restart: new empty memory, rehydrate from disk.
  const rehydrated = hydrateStageAttemptLedger(RUN, deps);
  assert.equal(rehydrated.ok, true);
  if (!rehydrated.ok) return;
  assert.equal(rehydrated.ledger.attempts.length, 1);

  const second = claimAndPersistStageAttempt(
    RUN,
    rehydrated.ledger,
    { headSha: HEAD, action: "ci_rerun" },
    deps,
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.created, false, "same identity must not double-charge");
  assert.equal(second.attempt.attempt_id, first.attempt.attempt_id);
  assert.equal(rehydrated.ledger.attempts.length, 1);

  const completed = completeAndPersistStageAttempt(
    RUN,
    rehydrated.ledger,
    { attemptId: first.attempt.attempt_id, succeeded: true },
    deps,
  );
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  assert.equal(completed.attempt.status, "completed");
  assert.equal(completed.attempt.terminal_outcome, "success");

  // Replay complete is idempotent.
  const replay = completeStageAttempt(rehydrated.ledger, {
    attemptId: first.attempt.attempt_id,
    succeeded: false,
    error: "should not overwrite",
  });
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.attempt.status, "completed");
  assert.equal(files.has(`${RUN}/stage-attempt-ledger.json`), true);
});

test("double-claim rejection: second claim returns existing without new charge", () => {
  const ledger = emptyStageAttemptLedger();
  const a = claimStageAttempt(ledger, { headSha: HEAD, action: "ci_assertion_fix" });
  const b = claimStageAttempt(ledger, { headSha: HEAD, action: "ci_assertion_fix" });
  assert.equal(a.ok && a.created, true);
  assert.equal(b.ok && b.created, false);
  assert.equal(ledger.attempts.length, 1);
});

test("supersession on HEAD movement frees new head budget", () => {
  const ledger = emptyStageAttemptLedger();
  const claimed = claimStageAttempt(ledger, { headSha: HEAD, action: "conflict_rebase" });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;
  const sup = supersedeStageAttempt(ledger, claimed.attempt.attempt_id, "head moved");
  assert.equal(sup.ok, true);
  if (!sup.ok) return;
  assert.equal(sup.attempt.status, "superseded");
  assert.equal(sup.attempt.terminal_outcome, "superseded");
  assert.equal(
    hasAttempted(ledger, HEAD, "conflict_rebase"),
    false,
    "superseded must not block as hasAttempted",
  );

  const onNewHead = claimStageAttempt(ledger, { headSha: HEAD2, action: "conflict_rebase" });
  assert.equal(onNewHead.ok && onNewHead.created, true);
});

test("migrate legacy pre-merge-ci-recovery.json into ledger attempts", () => {
  const { deps, files } = memoryDeps();
  files.set(
    `${RUN}/pre-merge-ci-recovery.json`,
    JSON.stringify({
      preArchiveSha: HEAD,
      ciRerunAttemptedShas: [HEAD],
      ciRebaseAttemptedForSha: HEAD2,
    }),
  );
  const hydrated = hydrateStageAttemptLedger(RUN, deps);
  assert.equal(hydrated.ok, true);
  if (!hydrated.ok) return;
  assert.equal(hydrated.migratedFromLegacy, true);
  assert.equal(hydrated.ledger.preArchiveSha, HEAD);
  assert.ok(hasAttempted(hydrated.ledger, HEAD, "ci_rerun"));
  assert.ok(hasAttempted(hydrated.ledger, HEAD2, "ci_rebase"));

  const projection = projectCiRecoveryFromLedger(hydrated.ledger);
  assert.deepEqual(projection.ciRerunAttemptedShas, [HEAD]);
  assert.ok(projection.ciRebaseAttemptedShas?.includes(HEAD2));
});

test("persist does not write legacy pre-merge-ci-recovery.json", () => {
  const { deps, files } = memoryDeps();
  const ledger = emptyStageAttemptLedger();
  claimStageAttempt(ledger, { headSha: HEAD, action: "ci_archive_fail_recovery" });
  const result = persistStageAttemptLedger(RUN, ledger, deps);
  assert.equal(result.ok, true);
  assert.ok(files.has(`${RUN}/stage-attempt-ledger.json`));
  assert.equal(files.has(`${RUN}/pre-merge-ci-recovery.json`), false);
});

test("syncCiProjectionIntoLedger is idempotent", () => {
  const ledger = emptyStageAttemptLedger();
  syncCiProjectionIntoLedger(
    ledger,
    { ciRerunAttemptedShas: [HEAD], noRunRecoveryAttemptedForSha: HEAD },
    "2026-08-02T12:00:00.000Z",
  );
  syncCiProjectionIntoLedger(
    ledger,
    { ciRerunAttemptedShas: [HEAD], noRunRecoveryAttemptedForSha: HEAD },
    "2026-08-02T12:00:00.000Z",
  );
  assert.equal(ledger.attempts.filter((a) => a.action === "ci_rerun").length, 1);
  assert.equal(ledger.attempts.filter((a) => a.action === "no_run_recovery").length, 1);
});

test("migrateLegacyCiMarkersToAttempts is pure", () => {
  const now = "2026-08-02T00:00:00.000Z";
  const { attempts, preArchiveSha } = migrateLegacyCiMarkersToAttempts(
    {
      preArchiveSha: HEAD,
      ciAssertionFixAttemptedShas: [HEAD],
      ciTerminalFailRecordedShas: [HEAD2],
    },
    now,
  );
  assert.equal(preArchiveSha, HEAD);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.action, "ci_assertion_fix");
});

test("shared identity: same item+candidate+evidence+recoveryAction yields same attempt_id", () => {
  const a = stageAttemptId({
    headSha: HEAD,
    action: "pre_merge_autofix",
    itemId: "759",
    candidateIdentity: HEAD,
    evidenceFingerprint: "abc",
    recoveryAction: "repair_pipeline_item",
  });
  const b = stageAttemptId({
    headSha: HEAD,
    action: "pre_merge_autofix",
    itemId: "759",
    candidateIdentity: HEAD,
    evidenceFingerprint: "abc",
    recoveryAction: "repair_pipeline_item",
  });
  assert.equal(a, b);
});
