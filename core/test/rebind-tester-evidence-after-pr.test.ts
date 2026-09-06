// #1468 post-PR Tester rebind. Injected I/O only — no live network, git, or subprocess.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  completingEvidenceBindingFailure,
  requiredEvidenceRoleForStage,
  runDeliveryStageAdapter,
} from "../scripts/issue-stage-adapters.ts";
import { DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import { selectNextApplicableStrategy } from "../scripts/loop/recovery-episodes.ts";
import {
  isRecoveryRecipe,
  RECOVERY_RECIPES,
  type RecoveryRecipe,
} from "../scripts/loop/types.ts";
import {
  createDeliveryStageEvidenceObserver,
  runAdvance,
  type AdvanceDeps,
} from "../scripts/pipeline-run.ts";
import {
  FACTORY_CONTROL_DIR_ENV,
  PRODUCTION_PIN_ENV,
} from "../scripts/production-engine-pin.ts";
import {
  buildTesterEvidenceOrderingDiagnostic,
  buildTesterRebindFailClosedDiagnostic,
  filterRecipesForTesterEvidenceOrdering,
  filterRecipesForWorkflowEngineDiagnostic,
  isConsumerImplementationStage,
  isTesterEvidenceOrderingDiagnostic,
  isTesterRebindBlockerCode,
  observeTesterImplementationRole,
  REBIND_TESTER_EVIDENCE_AFTER_PR,
  rebindTesterEvidenceAfterPr,
  testerEvidenceOrderingDiagnosticForRefuse,
  testerRebindBlockerPath,
  testerSubjectOmittedBecauseUnobservable,
  TESTER_EVIDENCE_ORDERING_INAPPLICABLE_RECIPES,
  TESTER_REBIND_BLOCKER_CODES,
  type RebindTesterEvidenceAfterPrInput,
  type TesterEvidenceOrderingFields,
} from "../scripts/rebind-tester-evidence-after-pr.ts";
import { runDirPath } from "../scripts/run-store.ts";
import {
  computeConfigDigest,
  TESTER_EVIDENCE_KIND,
  TESTER_EVIDENCE_SCHEMA_VERSION,
  testerEvidencePath,
  type TesterEvidence,
  type TesterEvidenceIoDeps,
} from "../scripts/tester-evidence.ts";
import { DEFAULT_CONFIG, type PipelineConfig, type Stage } from "../scripts/types.ts";

const SHA_S = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZERO_SHA = "0".repeat(40);
const VERIFIER_H = "c".repeat(64);
const ENGINE_FP = "d".repeat(64);
const __dirname = dirname(fileURLToPath(import.meta.url));

function memoryIo(files: Map<string, string> = new Map()): TesterEvidenceIoDeps & {
  files: Map<string, string>;
} {
  return {
    files,
    readFile: async (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p)!;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    rename: async (from, to) => {
      const data = files.get(from);
      if (data === undefined) {
        const err = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.set(to, data);
      files.delete(from);
    },
    mkdir: async () => {},
  };
}

function subjectlessPassed(over: Partial<TesterEvidence> = {}): TesterEvidence {
  return {
    schema_version: TESTER_EVIDENCE_SCHEMA_VERSION,
    kind: TESTER_EVIDENCE_KIND,
    candidate_sha: SHA_S,
    run_id: "1468/test-run",
    issue: 1468,
    pr: null,
    worktree_id: "pipeline-1468-wt",
    config_digest: computeConfigDigest({
      command_identity: "npm test",
      enabled: true,
      timeout: 300,
      max_output_chars: 4000,
    }),
    toolchain_fingerprint: { node: "v24.0.0", platform: "linux", arch: "x64" },
    started_at: "2026-09-05T20:00:00Z",
    ended_at: "2026-09-05T20:00:05Z",
    duration_ms: 5000,
    overall_status: "passed",
    commands: [
      {
        identity: "npm test",
        exit_code: 0,
        duration_ms: 4800,
        status: "passed",
        output_excerpt: "ok",
      },
    ],
    output_excerpt: "ok",
    producer: { component: "test-build-gate" },
    ...over,
  };
}

function cfg(): PipelineConfig {
  return {
    ...DEFAULT_CONFIG,
    domain: "acme",
    repo: "acme/widget",
    repo_dir: "/tmp/does-not-exist",
  };
}

function passthrough(sha = SHA_S): {
  outcome: "passthrough";
  candidate_sha: string;
  effective_verifier_hash: string;
} {
  return {
    outcome: "passthrough",
    candidate_sha: sha,
    effective_verifier_hash: VERIFIER_H,
  };
}

function blockedTs(sha = SHA_S): {
  outcome: "blocked";
  candidate_sha: string;
  effective_verifier_hash: null;
} {
  return { outcome: "blocked", candidate_sha: sha, effective_verifier_hash: null };
}

function plant(io: ReturnType<typeof memoryIo>, runDir: string, evidence: TesterEvidence): void {
  io.files.set(testerEvidencePath(runDir), `${JSON.stringify(evidence, null, 2)}\n`);
}

function baseInput(
  io: ReturnType<typeof memoryIo>,
  over: Partial<RebindTesterEvidenceAfterPrInput> = {},
): RebindTesterEvidenceAfterPrInput {
  return {
    cfg: cfg(),
    issueNumber: 1468,
    stage: "design-gate",
    runDir: "/runs/1468",
    prNumber: 99,
    prHeadSha: SHA_S,
    trustedSurface: passthrough(),
    domain: "acme",
    engineFingerprint: ENGINE_FP,
    io,
    ...over,
  };
}

async function bindThenObserve(input: {
  io: ReturnType<typeof memoryIo>;
  runDir: string;
  rebind?: RebindTesterEvidenceAfterPrInput;
}) {
  const result = await rebindTesterEvidenceAfterPr(
    input.rebind ?? baseInput(input.io, { runDir: input.runDir }),
  );
  const observer = createDeliveryStageEvidenceObserver(
    cfg(),
    1468,
    "design-gate",
    false,
    {
      getIssueDetail: async () => ({
        number: 1468,
        type: "issue",
        title: "t",
        body: "",
        state: "open",
        url: "https://example.test/1468",
        labels: ["pipeline:design-gate"],
        comments: [],
      }),
      getOnDiskForIssue: async () => null,
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_S }) as never,
      getPrDiff: async () => "",
      runDir: input.runDir,
      testerIo: input.io,
    },
  );
  const evidence = await observer("before");
  const binding = completingEvidenceBindingFailure({
    stage: "design-gate",
    ...evidence,
  });
  return { result, evidence, binding };
}

test("recipe id rebind_tester_evidence_after_pr is locked across catalogue and policy", async () => {
  assert.equal(REBIND_TESTER_EVIDENCE_AFTER_PR, "rebind_tester_evidence_after_pr");
  assert.equal(isRecoveryRecipe(REBIND_TESTER_EVIDENCE_AFTER_PR), true);
  assert.ok(RECOVERY_RECIPES.includes(REBIND_TESTER_EVIDENCE_AFTER_PR));
  const recipes = DEFAULT_RECOVERY_POLICY["workflow-engine-defect"].recipes;
  assert.ok(recipes.includes(REBIND_TESTER_EVIDENCE_AFTER_PR));
  const typesSrc = await readFile(
    join(__dirname, "../scripts/loop/types.ts"),
    "utf8",
  );
  assert.ok(typesSrc.includes('"rebind_tester_evidence_after_pr"'));
  const pipelineSrc = await readFile(join(__dirname, "../scripts/pipeline.ts"), "utf8");
  assert.ok(pipelineSrc.includes("rebind_tester_evidence_after_pr"));
});

test("consumer implementation stages exclude producers and planning-role stages", () => {
  assert.equal(isConsumerImplementationStage("design-gate"), true);
  assert.equal(isConsumerImplementationStage("review-1"), true);
  assert.equal(isConsumerImplementationStage("fix-1"), true);
  assert.equal(isConsumerImplementationStage("pre-merge"), true);
  assert.equal(isConsumerImplementationStage("implementing"), false);
  assert.equal(isConsumerImplementationStage("planning"), false);
  assert.equal(isConsumerImplementationStage("plan-review"), false);
  assert.equal(isConsumerImplementationStage("pre-code-attestation"), false);
  assert.equal(requiredEvidenceRoleForStage("design-gate"), "implementation");
});

test("1.1 subject-less Tester after test-gate-before-PR is rebound before design-gate observer", async () => {
  const io = memoryIo();
  const runDir = "/runs/1468";
  plant(io, runDir, subjectlessPassed());
  const { result, evidence, binding } = await bindThenObserve({ io, runDir });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action, "bind");
    assert.equal(result.suiteCommandInvoked, false);
    assert.equal(result.candidateSha, SHA_S);
    assert.equal(result.evidence.evidence_subject?.schema_version, 1);
    assert.equal(result.evidence.evidence_subject?.candidate_sha, SHA_S);
    assert.equal(result.evidence.evidence_subject?.verifier_fingerprint, VERIFIER_H);
  }
  assert.equal(evidence.evidenceRole, "implementation");
  assert.equal(evidence.candidateSha, SHA_S);
  assert.equal(binding, null);
  assert.notEqual(
    evidence.evidenceRole,
    null,
    "consumer observer must not refuse required implementation evidence role, observed missing",
  );
});

test("1.2 stale SHA A is not blessed as current implementation-role evidence for PR head B", async () => {
  const io = memoryIo();
  const runDir = "/runs/1468";
  plant(io, runDir, subjectlessPassed({ candidate_sha: SHA_S }));
  let reproducedFor: string | null = null;
  const result = await rebindTesterEvidenceAfterPr(
    baseInput(io, {
      runDir,
      prHeadSha: SHA_B,
      trustedSurface: passthrough(SHA_B),
      reproduce: async ({ candidateSha, runDir: dest }) => {
        reproducedFor = candidateSha;
        plant(
          io,
          dest,
          subjectlessPassed({
            candidate_sha: candidateSha,
            evidence_subject: {
              schema_version: 1,
              domain: "acme",
              issue: 1468,
              pr: 99,
              run_id: "1468/test-run",
              candidate_sha: candidateSha,
              diff_hash: null,
              policy_hash: "e".repeat(64),
              engine_fingerprint: ENGINE_FP,
              verifier_fingerprint: VERIFIER_H,
              required_evidence_set_revision: "f".repeat(64),
            },
          }),
        );
        return { ok: true, candidate_sha: candidateSha };
      },
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action, "reproduce");
    assert.equal(result.candidateSha, SHA_B);
    assert.notEqual(result.evidence.candidate_sha, SHA_S);
  }
  assert.equal(reproducedFor, SHA_B);
  const roleForB = observeTesterImplementationRole(
    result.ok ? result.evidence : null,
    SHA_B,
  );
  assert.ok(roleForB);
  const roleForS = observeTesterImplementationRole(subjectlessPassed(), SHA_B);
  assert.equal(roleForS, null);
});

test("1.2 blocked trusted-surface does not fabricate a subject", async () => {
  const io = memoryIo();
  const runDir = "/runs/1468";
  plant(io, runDir, subjectlessPassed());
  const result = await rebindTesterEvidenceAfterPr(
    baseInput(io, { runDir, trustedSurface: blockedTs() }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "tester_rebind_trusted_surface_unobservable");
    assert.equal(isTesterRebindBlockerCode(result.code), true);
    assert.equal(result.evidence?.evidence_subject, undefined);
  }
  const after = JSON.parse(io.files.get(testerEvidencePath(runDir)) ?? "{}") as TesterEvidence;
  assert.equal(after.evidence_subject, undefined);
  assert.equal(observeTesterImplementationRole(after, SHA_S), null);
});

test("1.3 missing PR head after push is a typed blocker, not generic observed missing", async () => {
  const io = memoryIo();
  const runDir = "/runs/1468";
  plant(io, runDir, subjectlessPassed());
  const result = await rebindTesterEvidenceAfterPr(
    baseInput(io, { runDir, prHeadSha: "not-a-sha" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "tester_rebind_pr_head_unobservable");
    assert.ok(TESTER_REBIND_BLOCKER_CODES.includes(result.code));
    assert.notEqual(result.summary, "required implementation evidence role, observed missing");
    assert.match(result.summary, /tester_rebind_pr_head_unobservable|PR head/i);
    assert.equal(result.diagnostic.detail.evidence_ordering?.blocker_code, result.code);
    assert.equal(io.files.has(testerRebindBlockerPath(runDir)), true);
    const stored = JSON.parse(io.files.get(testerRebindBlockerPath(runDir))!) as {
      code: string;
    };
    assert.equal(stored.code, "tester_rebind_pr_head_unobservable");
  }
});

test("1.3 unobservable trusted-surface after push is a typed blocker", async () => {
  const io = memoryIo();
  const runDir = "/runs/1468";
  plant(io, runDir, subjectlessPassed());
  const result = await rebindTesterEvidenceAfterPr(
    baseInput(io, {
      runDir,
      trustedSurface: {
        outcome: "passthrough",
        candidate_sha: SHA_S,
        effective_verifier_hash: null,
      },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "tester_rebind_trusted_surface_unobservable");
    assert.notEqual(result.summary, "required implementation evidence role, observed missing");
  }
});

test("1.3 all-zero trusted-surface sentinel is not rebound", async () => {
  const io = memoryIo();
  const runDir = "/runs/1468";
  plant(io, runDir, subjectlessPassed());
  const result = await rebindTesterEvidenceAfterPr(
    baseInput(io, {
      runDir,
      trustedSurface: {
        outcome: "passthrough",
        candidate_sha: ZERO_SHA,
        effective_verifier_hash: VERIFIER_H,
      },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "tester_rebind_trusted_surface_unobservable");
  }
});

test("2.2 bind does not invoke a second suite command", async () => {
  const io = memoryIo();
  const runDir = "/runs/1468";
  plant(io, runDir, subjectlessPassed());
  let reproduceCalls = 0;
  const result = await rebindTesterEvidenceAfterPr(
    baseInput(io, {
      runDir,
      reproduce: async () => {
        reproduceCalls++;
        return { ok: true, candidate_sha: SHA_S };
      },
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action, "bind");
    assert.equal(result.suiteCommandInvoked, false);
  }
  assert.equal(reproduceCalls, 0);
});

test("2.3 missing SHA-matched record reproduces rather than blessing SHA A", async () => {
  const io = memoryIo();
  const runDir = "/runs/1468";
  let reproduceCalls = 0;
  const result = await rebindTesterEvidenceAfterPr(
    baseInput(io, {
      runDir,
      prHeadSha: SHA_B,
      trustedSurface: passthrough(SHA_B),
      reproduce: async ({ candidateSha, runDir: dest }) => {
        reproduceCalls++;
        plant(
          io,
          dest,
          subjectlessPassed({
            candidate_sha: candidateSha,
            evidence_subject: {
              schema_version: 1,
              domain: "acme",
              issue: 1468,
              pr: 99,
              run_id: "1468/test-run",
              candidate_sha: candidateSha,
              diff_hash: null,
              policy_hash: "e".repeat(64),
              engine_fingerprint: ENGINE_FP,
              verifier_fingerprint: VERIFIER_H,
              required_evidence_set_revision: "f".repeat(64),
            },
          }),
        );
        return { ok: true, candidate_sha: candidateSha };
      },
    }),
  );
  assert.equal(reproduceCalls, 1);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action, "reproduce");
    assert.equal(result.candidateSha, SHA_B);
    assert.equal(result.suiteCommandInvoked, true);
  }
});

test("3.1 observer treats rebound Tester evidence as implementation-role proof", async () => {
  const io = memoryIo();
  const runDir = "/runs/1468";
  plant(io, runDir, subjectlessPassed());
  const { binding, evidence } = await bindThenObserve({ io, runDir });
  assert.equal(binding, null);
  assert.equal(evidence.evidenceRole, "implementation");
  assert.equal(evidence.postconditionProven, true);
  assert.match(String(evidence.artifactIdentity), /^tester:/);
});

test("3.2 subject-less Tester is not implementation proof", () => {
  const evidence = subjectlessPassed();
  assert.equal(observeTesterImplementationRole(evidence, SHA_S), null);
  const binding = completingEvidenceBindingFailure({
    stage: "design-gate",
    candidateSha: SHA_S,
    candidateEpoch: SHA_S,
    evidenceRole: null,
    artifactIdentity: null,
  });
  assert.equal(binding, "required implementation evidence role, observed missing");
});

test("3.2 SHA-mismatched Tester is not implementation proof", () => {
  const evidence = subjectlessPassed({
    candidate_sha: SHA_S,
    evidence_subject: {
      schema_version: 1,
      domain: "acme",
      issue: 1468,
      pr: 99,
      run_id: "1468/test-run",
      candidate_sha: SHA_S,
      diff_hash: null,
      policy_hash: "e".repeat(64),
      engine_fingerprint: ENGINE_FP,
      verifier_fingerprint: VERIFIER_H,
      required_evidence_set_revision: "f".repeat(64),
    },
  });
  assert.equal(observeTesterImplementationRole(evidence, SHA_B), null);
});

test("3.2 planning-role artifacts still cannot complete design-gate", async () => {
  const outcome = await runDeliveryStageAdapter({
    stage: "design-gate",
    cfg: { repo: "acme/widget", domain: "acme" },
    issueNumber: 1468,
    requireEvidenceBeforeAttempt: true,
    observeEvidence: async () => ({
      candidateSha: SHA_S,
      candidateEpoch: SHA_S,
      evidenceRole: "planning",
      artifactIdentity: "planning:plan",
      postconditionProven: true,
    }),
    attempt: async () => {
      assert.fail("design-gate handler must not run on planning-only evidence");
      return { advanced: true, from: "design-gate", to: "review-1", summary: "no" };
    },
  });
  assert.equal(outcome.advanced, false);
  if (!outcome.advanced) {
    assert.match(outcome.reason, /required implementation evidence role/);
  }
});

test("3.3 nested advance, single, loop, and FRG share runAdvance rebind", async () => {
  const runAdvanceSrc = await readFile(join(__dirname, "../scripts/pipeline-run.ts"), "utf8");
  assert.match(runAdvanceSrc, /rebindTesterEvidenceAfterPr/);
  assert.match(runAdvanceSrc, /isConsumerImplementationStage\(stage\)/);
  assert.match(runAdvanceSrc, /pushedHeadSha/);
  assert.match(runAdvanceSrc, /testerEvidenceOrderingDiagnosticForRefuse/);
  assert.match(runAdvanceSrc, /resolvePriorShaMatchedTester/);
  assert.match(runAdvanceSrc, /if \(!rebind\.ok\) \{/);
  assert.match(runAdvanceSrc, /return await failClosedRebind\(rebind\)/);
  assert.doesNotMatch(
    runAdvanceSrc,
    /if \(stage === "design-gate"\) \{\s*return await failClosedRebind/,
  );
  assert.doesNotMatch(runAdvanceSrc, /existingTester\.status === "missing"/);
  const nestedSrc = await readFile(join(__dirname, "../scripts/nested-advance.ts"), "utf8");
  assert.match(nestedSrc, /runAdvance/);
  assert.doesNotMatch(nestedSrc, /skip.*rebind|rebind.*skip/i);
  const pipelineSrc = await readFile(join(__dirname, "../scripts/pipeline.ts"), "utf8");
  assert.match(pipelineSrc, /runAdvance/);
  assert.match(pipelineSrc, /pushedHeadSha/);
  assert.match(pipelineSrc, /engineFingerprint/);
});

test("1.4 / 4.2 evidence-ordering diagnostic does not charge scratch or publish", () => {
  const diagnostic = buildTesterEvidenceOrderingDiagnostic({
    stage: "design-gate",
    prHead: SHA_S,
    trustedSurfaceOutcome: "passthrough",
    subjectOmittedBecauseUnobservable: true,
  });
  assert.equal(isTesterEvidenceOrderingDiagnostic(diagnostic), true);
  const recipes = DEFAULT_RECOVERY_POLICY["workflow-engine-defect"].recipes;
  const applicable = filterRecipesForWorkflowEngineDiagnostic(recipes, diagnostic);
  for (const skipped of TESTER_EVIDENCE_ORDERING_INAPPLICABLE_RECIPES) {
    assert.equal(applicable.includes(skipped), false, skipped);
  }
  assert.equal(applicable.includes(REBIND_TESTER_EVIDENCE_AFTER_PR), true);
  const selected = selectNextApplicableStrategy({
    recipes,
    cursor: 0,
    attemptsPerStrategy: {},
    strategyBound: () => 2,
    isApplicable: (recipe) => applicable.includes(recipe),
  });
  assert.equal(selected.kind, "claim");
  if (selected.kind === "claim") {
    assert.equal(selected.action, REBIND_TESTER_EVIDENCE_AFTER_PR);
    for (const skipped of selected.skipped) {
      assert.ok(
        (TESTER_EVIDENCE_ORDERING_INAPPLICABLE_RECIPES as readonly string[]).includes(skipped),
      );
    }
  }
});

test("4.2 inapplicable scratch is a skip, not a spent success", () => {
  const diagnostic = buildTesterEvidenceOrderingDiagnostic({
    stage: "design-gate",
    prHead: SHA_S,
    trustedSurfaceOutcome: "rebound",
  });
  const filtered = filterRecipesForTesterEvidenceOrdering([
    "unlink_engine_scratch",
    "checkpoint_owned_harness_dirt",
    "publish_unpublished_stage_commit",
    REBIND_TESTER_EVIDENCE_AFTER_PR,
  ] as const);
  assert.deepEqual([...filtered], [REBIND_TESTER_EVIDENCE_AFTER_PR]);
  const unrelated = filterRecipesForWorkflowEngineDiagnostic(
    DEFAULT_RECOVERY_POLICY["workflow-engine-defect"].recipes,
    { schema: "other" },
  );
  assert.equal(unrelated.includes("unlink_engine_scratch"), true);
  assert.equal(unrelated.includes(REBIND_TESTER_EVIDENCE_AFTER_PR), false);
  assert.equal(isTesterEvidenceOrderingDiagnostic(diagnostic), true);
});

test("4.2 classification uses structured fields, not prose", () => {
  const proseOnly = {
    schema: "pipeline/stage-diagnostic@1",
    reason_code: "workflow-engine-defect",
    evidence_key: "sha256:x",
    detail: {
      blocker_kind: "harness-failure",
      reason: "required implementation evidence role, observed missing",
      stage: "design-gate",
    },
  };
  assert.equal(isTesterEvidenceOrderingDiagnostic(proseOnly), false);
  const fields: TesterEvidenceOrderingFields = {
    kind: "tester_rebind_after_pr",
    required_role: "implementation",
    observed_role: "missing",
    trusted_surface_outcome: "passthrough",
    pr_head: SHA_S,
  };
  assert.equal(
    isTesterEvidenceOrderingDiagnostic({
      ...proseOnly,
      detail: { ...proseOnly.detail, evidence_ordering: fields },
    }),
    true,
  );
});

test("4.3 blocked trusted-surface recovery does not report recovered or invent a subject", async () => {
  const io = memoryIo();
  const runDir = "/runs/1468";
  plant(io, runDir, subjectlessPassed());
  const result = await rebindTesterEvidenceAfterPr(
    baseInput(io, { runDir, trustedSurface: blockedTs() }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "tester_rebind_trusted_surface_unobservable");
  }
  const after = JSON.parse(io.files.get(testerEvidencePath(runDir)) ?? "{}") as TesterEvidence;
  assert.equal(after.evidence_subject, undefined);
});

test("policy-order: unlink, checkpoint, publish, rebind, then repair", () => {
  const recipes = DEFAULT_RECOVERY_POLICY["workflow-engine-defect"].recipes;
  const unlink = recipes.indexOf("unlink_engine_scratch");
  const checkpoint = recipes.indexOf("checkpoint_owned_harness_dirt");
  const publish = recipes.indexOf("publish_unpublished_stage_commit");
  const rebind = recipes.indexOf(REBIND_TESTER_EVIDENCE_AFTER_PR);
  const repair = recipes.indexOf("repair_pipeline_item");
  assert.ok(unlink < checkpoint && checkpoint < publish, recipes.join(" → "));
  assert.ok(publish < rebind && rebind < repair, recipes.join(" → "));
  assert.notEqual(recipes[0], "repair_pipeline_item");
});

test("4.2 production missing-role refuse attaches structured evidence-ordering diagnostic", () => {
  assert.equal(testerSubjectOmittedBecauseUnobservable(subjectlessPassed()), true);
  const attached = testerEvidenceOrderingDiagnosticForRefuse({
    stage: "design-gate",
    bindingFailure: "delivery-stage evidence binding refused before execution: required implementation evidence role, observed missing",
    prHead: SHA_S,
    trustedSurface: passthrough(),
    subjectOmittedBecauseUnobservable: true,
  });
  assert.ok(attached);
  assert.equal(isTesterEvidenceOrderingDiagnostic(attached), true);
  assert.equal(attached!.detail.evidence_ordering?.kind, "tester_rebind_after_pr");
  assert.equal(attached!.detail.evidence_ordering?.observed_role, "missing");
  const proseOnly = testerEvidenceOrderingDiagnosticForRefuse({
    stage: "design-gate",
    bindingFailure: "delivery-stage evidence binding refused before execution: required implementation evidence role, observed missing",
    prHead: SHA_S,
    trustedSurface: blockedTs(),
  });
  assert.equal(proseOnly, null);
});

function withoutHostPinAuthorityEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const savedPin = process.env[PRODUCTION_PIN_ENV];
  const savedControl = process.env[FACTORY_CONTROL_DIR_ENV];
  delete process.env[PRODUCTION_PIN_ENV];
  delete process.env[FACTORY_CONTROL_DIR_ENV];
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      if (savedPin === undefined) delete process.env[PRODUCTION_PIN_ENV];
      else process.env[PRODUCTION_PIN_ENV] = savedPin;
      if (savedControl === undefined) delete process.env[FACTORY_CONTROL_DIR_ENV];
      else process.env[FACTORY_CONTROL_DIR_ENV] = savedControl;
    });
}

const ENGINE = {
  version: "1.40.1",
  root: "/skill/core",
  templates_fingerprint: "e".repeat(64),
  commit_sha: "f".repeat(40),
};

async function driveDesignGateAdvance(opts: {
  prNumber: number | null;
  prHeadSha?: string | null;
  prHeadSequence?: string[];
  worktreeHead?: string | null;
  changedPaths?: string[];
  tester?: TesterEvidence | null;
  priorTester?: TesterEvidence | null;
  startStage?: Stage;
  testGateEnabled?: boolean;
  /** Invoke the delivery observer created by runAdvance (post-confirmation race). */
  invokeObserver?: boolean;
  /** Also invoke the post-attempt observer (S1-before / S2-after race). */
  invokeObserverAfter?: boolean;
  rebind?: AdvanceDeps["rebindTesterEvidenceAfterPr"];
  dispatch?: AdvanceDeps["dispatch"];
}): Promise<{
  rebindCalls: RebindTesterEvidenceAfterPrInput[];
  setBlocked: Array<{ reason: string; kind: string | undefined }>;
  blockerEvents: Array<Record<string, unknown>>;
  dispatchCalls: number;
  observerBefore: {
    candidateSha?: string;
    evidenceRole?: string | null;
    artifactIdentity?: string | null;
  } | null;
  observerAfter: {
    candidateSha?: string;
    evidenceRole?: string | null;
    artifactIdentity?: string | null;
  } | null;
}> {
  const repoDir = fs.mkdtempSync(join(os.tmpdir(), "rebind-run-advance-"));
  const domain = `rebind-adv-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stateDir = `/tmp/pipeline-${domain}`;
  const issue = 1468;
  const runId = `${issue}-2026-09-05T21-12-47-000Z`;
  const runDir = runDirPath(repoDir, runId);
  const io = memoryIo();
  if (opts.tester) plant(io, runDir, opts.tester);
  if (opts.priorTester) {
    const priorRunId = `${issue}-2026-09-05T20-00-00-000Z`;
    const priorDir = runDirPath(repoDir, priorRunId);
    fs.mkdirSync(priorDir, { recursive: true });
    plant(io, priorDir, opts.priorTester);
  }
  const rebindCalls: RebindTesterEvidenceAfterPrInput[] = [];
  const setBlocked: Array<{ reason: string; kind: string | undefined }> = [];
  let observerBefore: {
    candidateSha?: string;
    evidenceRole?: string | null;
    artifactIdentity?: string | null;
  } | null = null;
  let observerAfter: {
    candidateSha?: string;
    evidenceRole?: string | null;
    artifactIdentity?: string | null;
  } | null = null;
  const startStage = opts.startStage ?? "design-gate";
  const labels = [`pipeline:${startStage}`];
  let prHeadReads = 0;
  let dispatchCalls = 0;
  const pipelineCfg = {
    repo: "acme/widget",
    domain,
    repo_dir: repoDir,
    worktree_root: ".worktrees",
    base_branch: "main",
    invocation: "pipeline",
    marker_footer: "*Automated by Claude Code Pipeline Skill*",
    harnesses: {
      implementer: "claude",
      implementerSource: "default",
      reviewer: "codex",
      reviewerSource: "default",
    },
    steps: { standard_review: true, adversarial_review: true },
    auto_loop: { enabled: false, max_rounds: 3, max_wallclock_minutes: 60, stages: [] },
    papercuts: { enabled: false, auto_file: false },
    corrections: { auto_file: false },
    test_gate: {
      ...DEFAULT_CONFIG.test_gate,
      enabled: opts.testGateEnabled ?? DEFAULT_CONFIG.test_gate.enabled,
    },
  } as unknown as PipelineConfig;
  const deps: AdvanceDeps = {
    resolvePinnedEngineIdentity: () => ENGINE,
    probeEngineIdentity: () => null,
    enforceEngineTrack: async () => ({ ok: true as const, track: "candidate" as const }),
    releaseParkedWorktree: async () => ({
      action: "absent",
      reason: "no managed worktree",
      branch: null,
      worktree: null,
    }),
    ensurePipelineLabels: async () => {},
    getIssueDetail: (async () => ({
      number: issue,
      type: "issue",
      title: "t",
      body: "",
      state: "open",
      url: `https://example.test/${issue}`,
      labels,
      comments: [
        {
          author: "pipeline-bot",
          body: `## Pipeline: ${startStage}\n<!-- pipeline-audit: run=${runId} state=${startStage} -->`,
        },
        {
          author: "pipeline-bot",
          body: `## Pipeline: review-1\n<!-- pipeline-audit: run=${runId} state=review-1 -->`,
        },
      ],
    })) as AdvanceDeps["getIssueDetail"],
    getGhActor: async () => "pipeline-bot",
    getPrForIssue: async () => opts.prNumber,
    getPrDetail: async () => {
      if (!opts.prNumber) return null;
      const sequenced = opts.prHeadSequence?.[prHeadReads++];
      return {
        number: opts.prNumber,
        head_sha: sequenced ?? opts.prHeadSha ?? SHA_S,
      } as never;
    },
    getOnDiskForIssue: async () =>
      opts.worktreeHead ? ({ path: "/wt/1468", slug: "1468-x" } as never) : null,
    gitInWorktree: async (_cwd, args) => {
      if (args[0] === "rev-parse" && args.includes("HEAD")) {
        return { stdout: `${opts.worktreeHead ?? ""}\n`, stderr: "", code: opts.worktreeHead ? 0 : 1 };
      }
      if (args[0] === "diff") {
        return {
          stdout: (opts.changedPaths ?? []).join("\n") + (opts.changedPaths?.length ? "\n" : ""),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "log" || args[0] === "show") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    lastAdvancedCandidateSha: opts.worktreeHead ?? opts.prHeadSha ?? SHA_S,
    trustedSurfaceObjectSource: {
      listChangedPaths: async () => ({ paths: [] }),
      resolveBaseSha: async () => SHA_S,
    },
    testerIo: io,
    rebindTesterEvidenceAfterPr: async (input) => {
      rebindCalls.push(input);
      if (opts.rebind) return opts.rebind(input);
      return rebindTesterEvidenceAfterPr(input);
    },
    setBlocked: (async (_c, _n, reason, _stage, kind) => {
      setBlocked.push({ reason, kind });
      if (!labels.includes("blocked")) labels.push("blocked");
    }) as AdvanceDeps["setBlocked"],
    postComment: async () => {},
    postPrComment: async () => {},
    dispatch: async (_c, _n, stage, dispatchOpts, ...rest) => {
      dispatchCalls++;
      if (opts.invokeObserver) {
        const observed = await dispatchOpts?.observeDeliveryStageEvidence?.("before");
        if (observed) {
          observerBefore = {
            candidateSha: observed.candidateSha,
            evidenceRole: observed.evidenceRole ?? null,
            artifactIdentity: observed.artifactIdentity ?? null,
          };
        }
      }
      const result = opts.dispatch
        ? await opts.dispatch(_c, _n, stage, dispatchOpts, ...rest)
        : {
            advanced: false as const,
            status: "waiting" as const,
            reason: "delivery-stage evidence binding refused before execution: required implementation evidence role, observed missing",
          };
      if (opts.invokeObserverAfter) {
        const observed = await dispatchOpts?.observeDeliveryStageEvidence?.("after", result);
        if (observed) {
          observerAfter = {
            candidateSha: observed.candidateSha,
            evidenceRole: observed.evidenceRole ?? null,
            artifactIdentity: observed.artifactIdentity ?? null,
          };
        }
      }
      if (result.advanced) {
        const idx = labels.findIndex((label) => label.startsWith("pipeline:"));
        if (idx >= 0) labels[idx] = `pipeline:${result.to}`;
        else labels.push(`pipeline:${result.to}`);
      }
      return result;
    },
  };
  try {
    await withoutHostPinAuthorityEnv(() =>
      runAdvance(pipelineCfg, issue, { runId, once: true }, deps),
    );
    const eventsPath = join(runDir, "events.jsonl");
    const blockerEvents = fs.existsSync(eventsPath)
      ? fs
          .readFileSync(eventsPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((event) => event.type === "blocker_set")
      : [];
    return { rebindCalls, setBlocked, blockerEvents, dispatchCalls, observerBefore, observerAfter };
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test("runAdvance invokes rebind when Tester evidence is missing", async () => {
  const driven = await driveDesignGateAdvance({
    prNumber: 99,
    prHeadSha: SHA_S,
    worktreeHead: SHA_S,
    rebind: async (input) => ({
      ok: true,
      action: "reproduce",
      candidateSha: SHA_S,
      evidence: subjectlessPassed(),
      suiteCommandInvoked: true,
    }),
    dispatch: async (_c, _n, stage) =>
      stage === "design-gate"
        ? {
            advanced: true,
            from: "design-gate",
            to: "review-1",
            summary: "design-gate passed",
          }
        : { advanced: false, status: "waiting", reason: "stop after rebind" },
  });
  assert.equal(driven.rebindCalls.length, 1);
  assert.equal(driven.rebindCalls[0]?.prNumber, 99);
  assert.equal(driven.rebindCalls[0]?.prHeadSha, SHA_S);
});

test("runAdvance fail-closes when the linked PR is unobservable", async () => {
  const driven = await driveDesignGateAdvance({
    prNumber: null,
    worktreeHead: SHA_S,
  });
  assert.equal(driven.rebindCalls.length, 1);
  assert.equal(driven.rebindCalls[0]?.prNumber, null);
  assert.equal(driven.rebindCalls[0]?.prHeadSha, null);
  assert.equal(driven.dispatchCalls, 0);
  assert.ok(driven.setBlocked.some((row) => /PR head|unobservable/i.test(row.reason)));
  assert.equal(driven.blockerEvents[0]?.blocker_kind, "harness-failure");
  assert.equal(
    (driven.blockerEvents[0]?.diagnostic as { detail?: { evidence_ordering?: { blocker_code?: string } } })
      ?.detail?.evidence_ordering?.blocker_code,
    "tester_rebind_pr_head_unobservable",
  );
});

test("runAdvance fail-closes later consumer stages on typed rebind failure", async () => {
  for (const startStage of ["review-1", "fix-1", "pre-merge"] as const) {
    const driven = await driveDesignGateAdvance({
      startStage,
      prNumber: 99,
      prHeadSha: SHA_S,
      worktreeHead: SHA_S,
      rebind: async () => ({
        ok: false,
        code: "tester_rebind_trusted_surface_unobservable",
        summary:
          "tester rebind: trusted-surface is not passthrough/rebound with a trustworthy verifier pin",
        candidateSha: SHA_S,
        evidence: null,
        diagnostic: buildTesterRebindFailClosedDiagnostic({
          stage: startStage,
          code: "tester_rebind_trusted_surface_unobservable",
          summary:
            "tester rebind: trusted-surface is not passthrough/rebound with a trustworthy verifier pin",
          prHead: SHA_S,
          trustedSurfaceOutcome: "blocked",
        }),
        blocker: {
          schema_version: 1,
          kind: "tester_rebind_blocker",
          code: "tester_rebind_trusted_surface_unobservable",
          candidate_sha: SHA_S,
          pr: 99,
          summary: "blocked trusted-surface",
        },
      }),
    });
    assert.equal(driven.dispatchCalls, 0, startStage);
    assert.ok(
      driven.setBlocked.some((row) => /trusted-surface/i.test(row.reason)),
      startStage,
    );
    assert.equal(
      (driven.blockerEvents[0]?.diagnostic as { detail?: { evidence_ordering?: { blocker_code?: string } } })
        ?.detail?.evidence_ordering?.blocker_code,
      "tester_rebind_trusted_surface_unobservable",
      startStage,
    );
    assert.ok(
      !driven.setBlocked.some((row) =>
        /required implementation evidence role, observed missing/.test(row.reason),
      ),
      startStage,
    );
  }
});

test("runAdvance fail-closes when PR head disagrees with the pushed head", async () => {
  const driven = await driveDesignGateAdvance({
    prNumber: 99,
    prHeadSha: SHA_B,
    worktreeHead: SHA_S,
  });
  assert.equal(driven.rebindCalls.length, 1);
  assert.equal(driven.rebindCalls[0]?.pushedHeadSha, SHA_S);
  assert.equal(driven.rebindCalls[0]?.prHeadSha, SHA_B);
  assert.ok(driven.setBlocked.some((row) => /disagrees with pushed head/.test(row.reason)));
  assert.equal(
    (driven.blockerEvents[0]?.diagnostic as { detail?: { evidence_ordering?: { blocker_code?: string } } })
      ?.detail?.evidence_ordering?.blocker_code,
    "tester_rebind_pr_head_mismatch",
  );
});

test("runAdvance attaches evidence-ordering diagnostic to a missing-role refuse", async () => {
  const driven = await driveDesignGateAdvance({
    prNumber: 99,
    prHeadSha: SHA_S,
    worktreeHead: SHA_S,
    tester: subjectlessPassed(),
    rebind: async () => ({
      ok: true,
      action: "bind",
      candidateSha: SHA_S,
      evidence: subjectlessPassed(),
      suiteCommandInvoked: false,
    }),
  });
  assert.equal(driven.rebindCalls.length, 1);
  assert.ok(
    driven.setBlocked.some((row) =>
      /required implementation evidence role, observed missing/.test(row.reason),
    ),
  );
  const diagnostic = driven.blockerEvents[0]?.diagnostic;
  assert.equal(isTesterEvidenceOrderingDiagnostic(diagnostic), true);
});

function boundPassed(over: Partial<TesterEvidence> = {}): TesterEvidence {
  return subjectlessPassed({
    evidence_subject: {
      schema_version: 1,
      domain: "acme",
      issue: 1468,
      pr: 99,
      run_id: "1468/test-run",
      candidate_sha: SHA_S,
      diff_hash: null,
      policy_hash: "e".repeat(64),
      engine_fingerprint: ENGINE_FP,
      verifier_fingerprint: VERIFIER_H,
      required_evidence_set_revision: "f".repeat(64),
    },
    ...over,
  });
}

test("disabled test gate does not fail-closed when no passed Tester record exists", async () => {
  const io = memoryIo();
  const runDir = "/runs/1468";
  let reproduced = false;
  const result = await rebindTesterEvidenceAfterPr(
    baseInput(io, {
      runDir,
      cfg: { ...cfg(), test_gate: { ...cfg().test_gate, enabled: false } },
      reproduce: async () => {
        reproduced = true;
        plant(io, runDir, subjectlessPassed({ overall_status: "disabled", commands: [] }));
        return { ok: true };
      },
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action, "not-applicable");
    assert.equal(result.suiteCommandInvoked, false);
  }
  assert.equal(reproduced, false);
});

test("disabled test gate skip lets observer use exact product-path proof", async () => {
  const io = memoryIo();
  const runDir = "/runs/1468";
  const result = await rebindTesterEvidenceAfterPr(
    baseInput(io, {
      runDir,
      cfg: { ...cfg(), test_gate: { ...cfg().test_gate, enabled: false } },
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.action, "not-applicable");
  const observer = createDeliveryStageEvidenceObserver(cfg(), 1468, "design-gate", false, {
    getIssueDetail: async () => ({
      number: 1468,
      type: "issue",
      title: "t",
      body: "",
      state: "open",
      url: "https://example.test/1468",
      labels: ["pipeline:design-gate"],
      comments: [],
    }),
    getOnDiskForIssue: async () => ({ path: "/wt/1468", slug: "1468-x" }) as never,
    gitInWorktree: async (_cwd, args) => {
      if (args[0] === "rev-parse") {
        return { stdout: `${SHA_S}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "diff") {
        return { stdout: "core/scripts/pipeline-run.ts\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    runDir,
    testerIo: io,
  });
  const evidence = await observer("before");
  const binding = completingEvidenceBindingFailure({
    stage: "design-gate",
    ...evidence,
  });
  assert.equal(evidence.evidenceRole, "implementation");
  assert.equal(binding, null);
});

test("helper adopts prior-run SHA-matched Tester evidence without a second suite", async () => {
  const io = memoryIo();
  const current = "/runs/1468-successor";
  const prior = boundPassed();
  let reproduced = false;
  const result = await rebindTesterEvidenceAfterPr(
    baseInput(io, {
      runDir: current,
      resolvePriorShaMatchedTester: async () => prior,
      reproduce: async () => {
        reproduced = true;
        return { ok: false };
      },
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action, "already-bound");
    assert.equal(result.suiteCommandInvoked, false);
    assert.equal(result.candidateSha, SHA_S);
  }
  assert.equal(reproduced, false);
  const stored = JSON.parse(io.files.get(testerEvidencePath(current)) ?? "{}") as TesterEvidence;
  assert.equal(stored.candidate_sha, SHA_S);
  assert.equal(stored.evidence_subject?.candidate_sha, SHA_S);
});

test("runAdvance successor adopts prior-run Tester evidence without reproducing", async () => {
  let reproduced = 0;
  const driven = await driveDesignGateAdvance({
    prNumber: 99,
    prHeadSha: SHA_S,
    worktreeHead: SHA_S,
    priorTester: boundPassed(),
    rebind: async (input) =>
      rebindTesterEvidenceAfterPr({
        ...input,
        reproduce: async () => {
          reproduced++;
          return { ok: false };
        },
      }),
    dispatch: async (_c, _n, stage) =>
      stage === "design-gate"
        ? {
            advanced: true,
            from: "design-gate",
            to: "review-1",
            summary: "design-gate passed",
          }
        : { advanced: false, status: "waiting", reason: "stop after adopt" },
  });
  assert.ok(driven.rebindCalls.length >= 1);
  assert.equal(reproduced, 0);
  assert.equal(driven.dispatchCalls, 1);
  assert.equal(driven.setBlocked.length, 0);
});

test("runAdvance invokes rebind at review-1 resume with subject-less Tester", async () => {
  const driven = await driveDesignGateAdvance({
    startStage: "review-1",
    prNumber: 99,
    prHeadSha: SHA_S,
    worktreeHead: SHA_S,
    tester: subjectlessPassed(),
    rebind: async () => ({
      ok: true,
      action: "bind",
      candidateSha: SHA_S,
      evidence: boundPassed(),
      suiteCommandInvoked: false,
    }),
  });
  assert.ok(driven.rebindCalls.length >= 1);
  assert.equal(driven.rebindCalls[0]?.stage, "review-1");
  assert.ok(
    driven.setBlocked.some((row) =>
      /required implementation evidence role, observed missing/.test(row.reason),
    ),
  );
  const diagnostic = driven.blockerEvents[0]?.diagnostic;
  assert.equal(isTesterEvidenceOrderingDiagnostic(diagnostic), true);
});

test("runAdvance fail-closes when PR head moves between bind and observer", async () => {
  const driven = await driveDesignGateAdvance({
    prNumber: 99,
    prHeadSha: SHA_S,
    prHeadSequence: [SHA_S, SHA_B],
    worktreeHead: SHA_S,
    tester: subjectlessPassed(),
  });
  assert.ok(driven.rebindCalls.length >= 2);
  assert.equal(driven.rebindCalls[0]?.prHeadSha, SHA_S);
  assert.equal(driven.rebindCalls[1]?.prHeadSha, SHA_B);
  assert.equal(driven.rebindCalls[1]?.pushedHeadSha, SHA_S);
  assert.equal(driven.dispatchCalls, 0);
  assert.equal(
    (driven.blockerEvents[0]?.diagnostic as { detail?: { evidence_ordering?: { blocker_code?: string } } })
      ?.detail?.evidence_ordering?.blocker_code,
    "tester_rebind_pr_head_mismatch",
  );
});

test("enabled test gate with unavailable producer fail-closes instead of not-applicable", async () => {
  const io = memoryIo();
  const result = await rebindTesterEvidenceAfterPr(
    baseInput(io, {
      cfg: { ...cfg(), test_gate: { ...cfg().test_gate, enabled: true } },
      reproduce: async () => ({ ok: false, unavailable: true }),
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "tester_rebind_trusted_surface_unobservable");
  }
});

test("runAdvance later-stage resume without worktree fail-closes when test gate is enabled", async () => {
  const driven = await driveDesignGateAdvance({
    startStage: "review-1",
    prNumber: 99,
    prHeadSha: SHA_S,
    worktreeHead: null,
    testGateEnabled: true,
  });
  assert.ok(driven.rebindCalls.length >= 1);
  assert.equal(driven.dispatchCalls, 0);
  assert.ok(driven.setBlocked.length > 0);
  assert.equal(
    (driven.blockerEvents[0]?.diagnostic as { detail?: { evidence_ordering?: { blocker_code?: string } } })
      ?.detail?.evidence_ordering?.blocker_code,
    "tester_rebind_trusted_surface_unobservable",
  );
  assert.ok(
    !driven.setBlocked.some((row) =>
      /required implementation evidence role, observed missing/.test(row.reason),
    ),
  );
});

test("observer does not accept worktree S1 proof when live PR head is S2", async () => {
  const io = memoryIo();
  const runDir = "/runs/1468";
  plant(io, runDir, boundPassed());
  let observedLive: string | null | undefined;
  const observer = createDeliveryStageEvidenceObserver(cfg(), 1468, "design-gate", false, {
    getIssueDetail: async () => ({
      number: 1468,
      type: "issue",
      title: "t",
      body: "",
      state: "open",
      url: "https://example.test/1468",
      labels: ["pipeline:design-gate"],
      comments: [],
    }),
    getOnDiskForIssue: async () => ({ path: "/wt/1468", slug: "1468-x" }) as never,
    gitInWorktree: async (_cwd, args) => {
      if (args[0] === "rev-parse") {
        return { stdout: `${SHA_S}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "diff") {
        return { stdout: "core/scripts/pipeline-run.ts\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    getPrForIssue: async () => 99,
    getPrDetail: async () => ({ number: 99, head_sha: SHA_B }) as never,
    getPrDiff: async () => "",
    expectedPrHeadSha: SHA_S,
    onObservedPrHead: async (liveSha) => {
      observedLive = liveSha;
    },
    runDir,
    testerIo: io,
  });
  const evidence = await observer("before");
  const binding = completingEvidenceBindingFailure({
    stage: "design-gate",
    ...evidence,
  });
  assert.equal(observedLive, SHA_B);
  assert.equal(evidence.candidateSha, SHA_B);
  assert.equal(evidence.evidenceRole, null);
  assert.ok(binding);
});

test("disabled-gate runAdvance fail-closes when PR head moves before observer", async () => {
  const driven = await driveDesignGateAdvance({
    prNumber: 99,
    prHeadSha: SHA_S,
    prHeadSequence: [SHA_S, SHA_B],
    worktreeHead: SHA_S,
    changedPaths: ["core/scripts/pipeline-run.ts"],
    testGateEnabled: false,
  });
  assert.ok(driven.rebindCalls.length >= 2);
  assert.equal(driven.rebindCalls[0]?.prHeadSha, SHA_S);
  assert.equal(driven.rebindCalls[1]?.prHeadSha, SHA_B);
  assert.equal(driven.rebindCalls[1]?.pushedHeadSha, SHA_S);
  assert.equal(driven.dispatchCalls, 0);
  assert.equal(
    (driven.blockerEvents[0]?.diagnostic as { detail?: { evidence_ordering?: { blocker_code?: string } } })
      ?.detail?.evidence_ordering?.blocker_code,
    "tester_rebind_pr_head_mismatch",
  );
});

test("disabled-gate observer does not accept worktree S1 proof when live PR head is S2", async () => {
  const driven = await driveDesignGateAdvance({
    prNumber: 99,
    prHeadSha: SHA_S,
    prHeadSequence: [SHA_S, SHA_S, SHA_B],
    worktreeHead: SHA_S,
    changedPaths: ["core/scripts/pipeline-run.ts"],
    testGateEnabled: false,
    invokeObserver: true,
  });
  assert.ok(driven.dispatchCalls >= 1);
  assert.ok(driven.rebindCalls.length >= 2);
  const lastRebind = driven.rebindCalls[driven.rebindCalls.length - 1];
  assert.equal(lastRebind?.prHeadSha, SHA_B);
  assert.equal(lastRebind?.pushedHeadSha, SHA_S);
  assert.equal(driven.observerBefore?.evidenceRole, null);
  assert.equal(
    (driven.blockerEvents[0]?.diagnostic as { detail?: { evidence_ordering?: { blocker_code?: string } } })
      ?.detail?.evidence_ordering?.blocker_code,
    "tester_rebind_pr_head_mismatch",
  );
});

test("runAdvance fail-closes when PR head moves after confirmation with worktree present", async () => {
  const driven = await driveDesignGateAdvance({
    prNumber: 99,
    prHeadSha: SHA_S,
    prHeadSequence: [SHA_S, SHA_S, SHA_B],
    worktreeHead: SHA_S,
    tester: boundPassed(),
    invokeObserver: true,
  });
  assert.ok(driven.dispatchCalls >= 1);
  assert.ok(driven.rebindCalls.length >= 2);
  const lastRebind = driven.rebindCalls[driven.rebindCalls.length - 1];
  assert.equal(lastRebind?.prHeadSha, SHA_B);
  assert.equal(lastRebind?.pushedHeadSha, SHA_S);
  assert.equal(driven.observerBefore?.evidenceRole, null);
  assert.equal(
    (driven.blockerEvents[0]?.diagnostic as { detail?: { evidence_ordering?: { blocker_code?: string } } })
      ?.detail?.evidence_ordering?.blocker_code,
    "tester_rebind_pr_head_mismatch",
  );
  assert.ok(driven.setBlocked.some((row) => /disagrees with pushed head/.test(row.reason)));
});

test("observer after phase invokes PR-head mismatch hook", async () => {
  const io = memoryIo();
  const runDir = "/runs/1468";
  plant(io, runDir, boundPassed());
  const observed: Array<{ phase: string; liveSha: string | null }> = [];
  const observer = createDeliveryStageEvidenceObserver(cfg(), 1468, "design-gate", false, {
    getIssueDetail: async () => ({
      number: 1468,
      type: "issue",
      title: "t",
      body: "",
      state: "open",
      url: "https://example.test/1468",
      labels: ["pipeline:design-gate"],
      comments: [],
    }),
    getOnDiskForIssue: async () => ({ path: "/wt/1468", slug: "1468-x" }) as never,
    gitInWorktree: async (_cwd, args) => {
      if (args[0] === "rev-parse") {
        return { stdout: `${SHA_S}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "diff") {
        return { stdout: "core/scripts/pipeline-run.ts\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    getPrForIssue: async () => 99,
    getPrDetail: async () => ({ number: 99, head_sha: SHA_B }) as never,
    getPrDiff: async () => "",
    expectedPrHeadSha: SHA_S,
    onObservedPrHead: async (liveSha) => {
      observed.push({ phase: "hook", liveSha });
    },
    runDir,
    testerIo: io,
  });
  const after = await observer("after");
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.liveSha, SHA_B);
  assert.equal(after.candidateSha, SHA_B);
  assert.equal(after.evidenceRole, null);
  assert.equal(after.postconditionProven, false);
});

test("runAdvance fail-closes post-attempt PR-head drift as typed mismatch, not generic wait", async () => {
  const driven = await driveDesignGateAdvance({
    prNumber: 99,
    prHeadSha: SHA_S,
    prHeadSequence: [SHA_S, SHA_S, SHA_S, SHA_B],
    worktreeHead: SHA_S,
    tester: boundPassed(),
    invokeObserver: true,
    invokeObserverAfter: true,
    dispatch: async () => ({
      advanced: false as const,
      status: "waiting" as const,
      reason:
        "delivery-stage Candidate binding changed during execution; RecoverySupervisor retains ownership and must rerun the stage against the replacement candidate",
    }),
  });
  assert.ok(driven.dispatchCalls >= 1);
  assert.equal(driven.observerBefore?.candidateSha, SHA_S);
  assert.equal(driven.observerBefore?.evidenceRole, "implementation");
  assert.equal(driven.observerAfter?.candidateSha, SHA_B);
  assert.equal(driven.observerAfter?.evidenceRole, null);
  const lastRebind = driven.rebindCalls[driven.rebindCalls.length - 1];
  assert.equal(lastRebind?.prHeadSha, SHA_B);
  assert.equal(lastRebind?.pushedHeadSha, SHA_S);
  const diagnostic = driven.blockerEvents[0]?.diagnostic;
  assert.equal(
    (diagnostic as { detail?: { evidence_ordering?: { blocker_code?: string } } })
      ?.detail?.evidence_ordering?.blocker_code,
    "tester_rebind_pr_head_mismatch",
  );
  assert.ok(driven.setBlocked.some((row) => /disagrees with pushed head/.test(row.reason)));
  assert.ok(
    !driven.setBlocked.some((row) => /Candidate binding changed during execution/.test(row.reason)),
  );
  assert.equal(isTesterEvidenceOrderingDiagnostic(diagnostic), true);
  const applicable = filterRecipesForWorkflowEngineDiagnostic(
    DEFAULT_RECOVERY_POLICY["workflow-engine-defect"].recipes,
    diagnostic,
  );
  for (const skipped of TESTER_EVIDENCE_ORDERING_INAPPLICABLE_RECIPES) {
    assert.equal(applicable.includes(skipped), false, skipped);
  }
  assert.equal(applicable.includes(REBIND_TESTER_EVIDENCE_AFTER_PR), true);
});
