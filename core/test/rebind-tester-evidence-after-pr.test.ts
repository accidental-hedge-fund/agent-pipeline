// #1468 post-PR Tester rebind. Injected I/O only — no live network, git, or subprocess.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
} from "../scripts/pipeline-run.ts";
import {
  buildTesterEvidenceOrderingDiagnostic,
  filterRecipesForTesterEvidenceOrdering,
  filterRecipesForWorkflowEngineDiagnostic,
  isConsumerImplementationStage,
  isTesterEvidenceOrderingDiagnostic,
  isTesterRebindBlockerCode,
  observeTesterImplementationRole,
  REBIND_TESTER_EVIDENCE_AFTER_PR,
  rebindTesterEvidenceAfterPr,
  testerRebindBlockerPath,
  TESTER_EVIDENCE_ORDERING_INAPPLICABLE_RECIPES,
  TESTER_REBIND_BLOCKER_CODES,
  type RebindTesterEvidenceAfterPrInput,
  type TesterEvidenceOrderingFields,
} from "../scripts/rebind-tester-evidence-after-pr.ts";
import {
  computeConfigDigest,
  TESTER_EVIDENCE_KIND,
  TESTER_EVIDENCE_SCHEMA_VERSION,
  testerEvidencePath,
  type TesterEvidence,
  type TesterEvidenceIoDeps,
} from "../scripts/tester-evidence.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";

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
  assert.match(runAdvanceSrc, /stage === "design-gate"/);
  const nestedSrc = await readFile(join(__dirname, "../scripts/nested-advance.ts"), "utf8");
  assert.match(nestedSrc, /runAdvance/);
  assert.doesNotMatch(nestedSrc, /skip.*rebind|rebind.*skip/i);
  const pipelineSrc = await readFile(join(__dirname, "../scripts/pipeline.ts"), "utf8");
  assert.match(pipelineSrc, /runAdvance/);
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
