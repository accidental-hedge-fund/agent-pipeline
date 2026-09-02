import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  alignReleaseCheckoutToCandidate,
  assertFrgCandidateProvenance,
  assertEnsureTagOidIsMergedRelease,
  bindCandidateShipEndOperations,
  boundPackLoopIsLive,
  classifyBoundPackLoopLiveness,
  classifyFrgPackWaitDecision,
  ensureAnnotatedReleaseTag,
  hmacPackedCandidateGitShaFromUnknown,
  loadRerunAttemptCount,
  persistShipFactoryReleaseRequest,
  persistedShipFactoryReleaseRequestPath,
  observeFrgEvidence,
  observeTrainEvidence,
  planTrainFromMilestoneIssues,
  probeBoundPackLoopLive,
  recordRerunAttemptFile,
  resolveEnsureTagOwnerRepo,
  runEnsureAnnotatedReleaseTagCli,
  shipCoordinatorDepsFromOperations,
  verifyAnnotatedReleaseTag,
  type ObservedEnsureTagReleasePr,
  type ObserveTrainEvidenceDeps,
  type ShipAdapterOperations,
} from "../scripts/stages/ship-adapter.ts";
import {
  getPrForIssueAnyState,
  type GhApiRunner,
} from "../scripts/gh.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import {
  attemptCountFor,
  emptyRerunBudgetDoc,
  MAX_RERUN_BUDGET,
  ShipReleaseCheckWaitError,
  withRecordedAttempt,
  type ShipReleaseCheckWaitDeps,
} from "../scripts/stages/ship-release-check-wait.ts";
import { LOOP_LEDGER_SCHEMA } from "../scripts/loop/types.ts";
import {
  buildFactoryReleaseUnsignedDigestBinding,
  defaultObserveAttestation,
  isPathInsideCheckout,
  type FactoryReleaseFrgPayload,
  type FactoryReleasePrepareRequest,
  type FactoryReleaseUnsignedDigestBinding,
} from "../scripts/factory-release-prepare.ts";
import {
  runShipCoordinator,
  shipKey,
  type ShipIntent,
  type ShipPhaseEvent,
  type ShipStateStore,
  type ShipStatus,
  type ShipTrainEvidence,
} from "../scripts/stages/ship.ts";
import {
  computeAttestorRunId,
  computeFrgEvidence,
  FRG_PACK_MANIFEST,
  FRG_UNIT_TEST_ATTESTATION_KEY,
  frgRequiredCompositionOverrides,
  frgRequiredObservationOverrides,
  shipMissingFrgDiagnostic,
  validateFrgEvidenceSnapshotForTag,
  validateReleaseEligibleFrgEvidence,
  writeFrgEvidence,
  type FrgEvidence,
  type FrgFsDeps,
} from "../scripts/factory-reliability-gate.ts";
import {
  collectFrgPackObservations,
  FRG_HYBRID_PILOT_POLICY_ID,
  FRG_HYBRID_V2_POLICY_ID,
  loadFrgPack,
  renderFrgPackIssues,
} from "../scripts/frg-pack-observations.ts";
import type { TrainIssueSnapshot } from "../scripts/stages/train.ts";
import { frgPassUniqueOperations } from "./frg-pass-unique-operations.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const head = "a".repeat(40);
const releaseHead = "b".repeat(40);
const mergeHead = "c".repeat(40);
const unrelatedOid = "e".repeat(40);

function hmacSnapshot(sha: string | null): unknown {
  if (!sha) return {};
  return { factory_release_binding: { candidate_git_sha: sha } };
}

const intent: ShipIntent = {
  repository: "accidental-hedge-fund/agent-pipeline",
  base_branch: "main",
  milestone: "v1.34.0",
  version: "1.34.0",
  event_id: "d".repeat(64),
  sender_id: "operator",
  channel_id: "pipeline-factory",
  thread_id: "release-1.34.0",
};

function mergedReleasePr(mergeCommitOid = mergeHead): ObservedEnsureTagReleasePr {
  return {
    pr: 945,
    title: `release: ${intent.version} — factory`,
    state: "MERGED",
    mergeCommitOid,
  };
}

const train: ShipTrainEvidence = {
  repository: intent.repository,
  base_branch: intent.base_branch,
  milestone: intent.milestone,
  complete: true,
  ordered_issues: [10, 11],
  run_id: null,
  integrated_head_oid: head,
  completed_at: "2026-08-10T12:00:00.000Z",
};

const frg = {
  version: intent.version,
  pass: true,
  loop_run_id: "loop-1",
  pack_id: "factory-gate-v1",
  run_id: "frg-1",
} as FrgEvidence;

const release = {
  repository: intent.repository,
  base_branch: intent.base_branch,
  version: intent.version,
  pr: 945,
  head_oid: releaseHead,
  candidate_head_oid: head,
};

const releaseFinish = {
  ...release,
  merged: true as const,
  merge_commit_oid: mergeHead,
};

const publication = {
  version: intent.version,
  tag: `v${intent.version}`,
  published: true as const,
  artifact_digest: mergeHead,
};

const promotion = {
  version: intent.version,
  tag: `v${intent.version}`,
  verified: true as const,
  installed_version: intent.version,
  pin_digest: mergeHead,
};

const deployment = {
  version: intent.version,
  tag: `v${intent.version}`,
  environment: "all",
  authorized_digest: mergeHead,
  live_digest: mergeHead,
  verified: true as const,
};

const state = {
  statusFile: () => "/state/status.json",
  eventsFile: () => "/state/events.jsonl",
  read: async () => null,
  writeAtomic: async () => {},
  appendEvent: async () => {},
} satisfies ShipStateStore;

function checkpoint(overrides: Partial<ShipStatus> = {}): ShipStatus {
  return {
    schema_version: 1,
    kind: "ship_status",
    ship_key: "ship-" + "1".repeat(24),
    run_id: "ship-" + "2".repeat(24),
    intent,
    authorization_fingerprint: "f".repeat(64),
    authorized_at: "2026-08-10T11:00:00.000Z",
    authorization_expires_at: "2026-08-11T11:00:00.000Z",
    events_file: "/state/events.jsonl",
    train_plan: { ordered_issues: [...train.ordered_issues] },
    revision: 0,
    next_action: "train_merge",
    complete: false,
    updated_at: "2026-08-10T11:00:00.000Z",
    last_error: null,
    train: null,
    frg_pack: null,
    frg: null,
    release: null,
    release_finish: null,
    publication: null,
    promotion: null,
    deployment: null,
    lineage: {
      integrated_candidate: null,
      frg_candidate: null,
      release_pr_head: null,
      release_merge_result: null,
      tag: null,
      published_artifact: null,
      promoted_pin: null,
      deployed: null,
    },
    ...overrides,
  };
}

function operations(overrides: Partial<ShipAdapterOperations> = {}): ShipAdapterOperations {
  return {
    planTrain: async () => ({ ordered_issues: [...train.ordered_issues] }),
    observeTrain: async () => train,
    runTrain: async () => train,
    observeFrg: async () => frg,
    observeRelease: async () => ({ prepare: release, finish: releaseFinish }),
    prepareRelease: async () => release,
    finishRelease: async () => releaseFinish,
    observePublication: async () => publication,
    waitForPublication: async () => publication,
    observePromotion: async () => promotion,
    promote: async () => promotion,
    observeDeployment: async () => deployment,
    deploy: async () => deployment,
    observeRemainingOpenMilestoneIssues: async () => [],
    ...overrides,
  };
}

test("ship adapter reconciliation projects only externally observed typed truth", async () => {
  const deps = shipCoordinatorDepsFromOperations(operations(), { state });

  const result = await deps.reconcile(intent, checkpoint());

  assert.equal(result.train?.integrated_head_oid, head);
  assert.equal(result.frg_pack?.candidate_head_oid, head);
  assert.equal(result.frg?.candidate_head_oid, head);
  assert.equal(result.release?.head_oid, releaseHead);
  assert.equal(result.release_finish?.merge_commit_oid, mergeHead);
  assert.deepEqual(result.publication, publication);
  assert.deepEqual(result.promotion, promotion);
});

test("ship adapter revalidates and retains a restart checkpoint after the release advanced base", async () => {
  const observed: string[] = [];
  const savedPack = {
    version: intent.version,
    complete: true as const,
    loop_run_id: "loop-1",
    pack_id: "factory-gate-v1",
    candidate_head_oid: head,
  };
  const savedFrg = {
    version: intent.version,
    pass: true as const,
    loop_run_id: "loop-1",
    frg_run_id: "frg-1",
    candidate_head_oid: head,
  };
  const saved = checkpoint({
    train,
    frg_pack: savedPack,
    frg: savedFrg,
    release,
    release_finish: releaseFinish,
    publication,
    promotion: null,
  });
  const deps = shipCoordinatorDepsFromOperations(operations({
    observeTrain: async (_intent, _plannedIssues, candidate) => {
      observed.push(`train:${candidate}`);
      return train;
    },
    observeFrg: async (_intent, _train, requireCurrentCandidate) => {
      observed.push(`frg:${requireCurrentCandidate}`);
      return frg;
    },
    observeRelease: async (_intent, candidate) => {
      observed.push(`release:${candidate}`);
      return { prepare: release, finish: releaseFinish };
    },
  }), { state });

  const result = await deps.reconcile(intent, saved);

  assert.equal(result.train, train);
  assert.equal(result.frg_pack, savedPack);
  assert.equal(result.frg, savedFrg);
  assert.equal(result.release, release);
  assert.equal(result.release_finish, releaseFinish);
  assert.deepEqual(observed, [`train:${head}`, "frg:false", `release:${head}`]);
});

test("ship adapter rejects release head drift after a prepare checkpoint", async () => {
  const saved = checkpoint({
    train,
    frg_pack: {
      version: intent.version,
      complete: true,
      loop_run_id: "loop-1",
      pack_id: "factory-gate-v1",
      candidate_head_oid: head,
    },
    frg: {
      version: intent.version,
      pass: true,
      loop_run_id: "loop-1",
      frg_run_id: "frg-1",
      candidate_head_oid: head,
    },
    release,
  });
  const changed = { ...release, head_oid: "e".repeat(40) };
  const deps = shipCoordinatorDepsFromOperations(operations({
    observeRelease: async () => ({ prepare: changed, finish: null }),
  }), { state });

  await assert.rejects(
    deps.reconcile(intent, saved),
    /persisted release PR identity changed/,
  );
});

test("ship adapter converges train through the existing train seam only when observation is incomplete", async () => {
  let runs = 0;
  const observedPlans: number[][] = [];
  const deps = shipCoordinatorDepsFromOperations(operations({
    observeTrain: async (_intent, plannedIssues) => {
      observedPlans.push([...plannedIssues]);
      return null;
    },
    runTrain: async (_intent, plannedIssues) => {
      runs++;
      observedPlans.push([...plannedIssues]);
      return train;
    },
  }), { state });

  assert.deepEqual(await deps.convergeTrain(intent, train.ordered_issues), train);
  assert.equal(runs, 1);
  assert.deepEqual(observedPlans, [[10, 11], [10, 11]]);
});

// ---------------------------------------------------------------------------
// observeTrain: merged pipeline (#N) mentions (#1269)
//
// v1.39.14 ship merged three train PRs whose squash titles are `… (#N)`.
// GitHub records CrossReferencedEvent with willCloseTarget=false. The shared
// any-state picker must treat those as links so observation returns complete
// evidence and ship does not re-enter runTrain.
// ---------------------------------------------------------------------------

const V13914_ISSUES = [1258, 1259, 1252] as const;
const V13914_MAIN = "aa".repeat(20);
const V13914_MERGED_AT = "2026-08-27T18:00:00.000Z";
const V13914_NOW = new Date("2026-08-27T21:36:57.000Z");

const V13914_PRS: Record<number, { pr: number; oid: string; head: string; title: string }> = {
  1258: {
    pr: 1262,
    oid: "f71c4251" + "a".repeat(32),
    head: "pipeline/1258-resume-after-run-fatal",
    title: "fix(pipeline): resume after run fatal (#1258)",
  },
  1259: {
    pr: 1263,
    oid: "28e04331" + "b".repeat(32),
    head: "pipeline/1259-ship-frg-wait",
    title: "fix(ship): frg wait (#1259)",
  },
  1252: {
    pr: 1267,
    oid: "c75522cd" + "c".repeat(32),
    head: "pipeline/1252-empty-freeze",
    title: "fix(ship): freeze empty milestone (#1252)",
  },
};

function graphqlIssueNumber(args: string[]): number {
  const arg = args.find((a) => a.startsWith("num="));
  if (!arg) throw new Error(`missing num= in GraphQL args: ${args.join(" ")}`);
  return Number(arg.slice(4));
}

function timelineGraphql(nodes: unknown[]): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasPreviousPage: false, startCursor: null },
            nodes,
          },
        },
      },
    },
  });
}

function mentionCrossRef(pr: { pr: number; head: string; title: string }, fork = false) {
  return {
    __typename: "CrossReferencedEvent",
    willCloseTarget: false,
    source: {
      __typename: "PullRequest",
      number: pr.pr,
      headRefName: pr.head,
      title: pr.title,
      isCrossRepository: fork,
    },
  };
}

function v13914TimelineRun(): GhApiRunner {
  return async (args) => {
    const joined = args.join(" ");
    assert.ok(args.includes("graphql"), "observeTrain lookup must be issue-timeline GraphQL");
    assert.ok(joined.includes("timelineItems"));
    assert.ok(!joined.includes("pr list"), "must not fall back to gh pr list");
    const issue = graphqlIssueNumber(args);
    const row = V13914_PRS[issue];
    if (!row) return timelineGraphql([]);
    return timelineGraphql([mentionCrossRef(row)]);
  };
}

function mergedView(oid: string): Record<string, unknown> {
  return {
    state: "MERGED",
    mergedAt: V13914_MERGED_AT,
    mergeCommit: { oid },
  };
}

function v13914ObserveDeps(run: GhApiRunner = v13914TimelineRun()): ObserveTrainEvidenceDeps {
  const cfg = { repo: intent.repository } as PipelineConfig;
  const oids = new Set(Object.values(V13914_PRS).map((row) => row.oid));
  const views = new Map(
    Object.values(V13914_PRS).map((row) => [row.pr, mergedView(row.oid)] as const),
  );
  return {
    getPrForIssueAnyState: (issue) => getPrForIssueAnyState(cfg, issue, run),
    ghPrView: async (pr) => {
      const row = views.get(pr);
      if (!row) throw new Error(`unexpected ghPrView for PR #${pr}`);
      return row;
    },
    observeBase: async () => V13914_MAIN,
    isAncestor: async (ancestor, descendant) => {
      if (ancestor === descendant) return true;
      return descendant === V13914_MAIN && oids.has(ancestor);
    },
    now: () => V13914_NOW,
  };
}

test("observeTrain: v1.39.14 merged (#N) pipeline PRs complete train evidence (#1269)", async () => {
  const evidence = await observeTrainEvidence(
    intent,
    [...V13914_ISSUES],
    v13914ObserveDeps(),
  );
  assert.ok(evidence, "must not return null for merged (#N) pipeline PRs");
  assert.equal(evidence.complete, true);
  assert.equal(evidence.integrated_head_oid, V13914_MAIN);
  assert.deepEqual(evidence.ordered_issues, [...V13914_ISSUES]);
  assert.equal(evidence.repository, intent.repository);
  assert.equal(evidence.milestone, intent.milestone);
});

test("convergeTrain: merged (#N) observation does not invoke runTrain (#1269)", async () => {
  let runs = 0;
  const deps = shipCoordinatorDepsFromOperations(operations({
    observeTrain: (i, planned, candidate) =>
      observeTrainEvidence(i, planned, v13914ObserveDeps(), candidate),
    runTrain: async () => {
      runs++;
      throw new Error("issue #1258 is ready-to-deploy but has no linked open PR");
    },
  }), { state });

  const observed = await deps.convergeTrain(intent, [...V13914_ISSUES]);
  assert.equal(runs, 0, "must not re-enter runTrain after observation succeeds");
  assert.equal(observed.integrated_head_oid, V13914_MAIN);
  assert.deepEqual(observed.ordered_issues, [...V13914_ISSUES]);
});

test("observeTrain: ConnectedEvent and willCloseTarget still prove integration (#1269)", async () => {
  const row = V13914_PRS[1258]!;
  const connectedRun: GhApiRunner = async () =>
    timelineGraphql([
      {
        __typename: "ConnectedEvent",
        subject: {
          __typename: "PullRequest",
          number: row.pr,
          headRefName: "feat/manual-link",
          title: "manual link",
          isCrossRepository: false,
        },
      },
    ]);
  const closingRun: GhApiRunner = async () =>
    timelineGraphql([
      {
        __typename: "CrossReferencedEvent",
        willCloseTarget: true,
        source: {
          __typename: "PullRequest",
          number: row.pr,
          headRefName: "feat/fixes-keyword",
          title: "Fixes #1258",
          isCrossRepository: false,
        },
      },
    ]);
  const connected = await observeTrainEvidence(intent, [1258], v13914ObserveDeps(connectedRun));
  const closing = await observeTrainEvidence(intent, [1258], v13914ObserveDeps(closingRun));
  assert.equal(connected?.integrated_head_oid, V13914_MAIN);
  assert.equal(closing?.integrated_head_oid, V13914_MAIN);
});

test("observeTrain: fork-only timeline is not integration proof (#1269)", async () => {
  const row = V13914_PRS[1258]!;
  const forkRun: GhApiRunner = async () => timelineGraphql([mentionCrossRef(row, true)]);
  const evidence = await observeTrainEvidence(intent, [1258], v13914ObserveDeps(forkRun));
  assert.equal(evidence, null);
});

function memFs(): FrgFsDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(p) {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    async writeFile(p, data) {
      files.set(p, data);
    },
    async mkdir() {},
    async rename(from, to) {
      const v = files.get(from);
      if (v === undefined) throw new Error(`ENOENT rename ${from}`);
      files.set(to, v);
      files.delete(from);
    },
  };
}

const intent13914: ShipIntent = {
  ...intent,
  milestone: "v1.39.14",
  version: "1.39.14",
  thread_id: "release-1.39.14",
};

const train13914: ShipTrainEvidence = {
  ...train,
  milestone: intent13914.milestone,
};

function observeFrgDeps(
  frgFs: FrgFsDeps,
  overrides: {
    observeBase?: () => Promise<string>;
    isAncestor?: (ancestor: string, descendant: string) => Promise<boolean>;
    readFile?: (path: string) => Promise<string>;
    resolveShipPathFromRun?: (args: {
      version: string;
      fromRun: string;
      repoDir: string;
      requestCandidateGitSha?: string;
      readFile: (p: string) => Promise<string>;
    }) => Promise<{
      kind: "standalone" | "bound" | "fail";
      binding?: unknown;
      unsigned_frg_run_id?: string;
      message?: string;
    }>;
  } = {},
) {
  return {
    repoDir: "/repo",
    observeBase: overrides.observeBase ?? (async () => head),
    isAncestor: overrides.isAncestor ?? (async (ancestor: string, descendant: string) => ancestor === descendant),
    frgFs,
    frgValidateOpts: { attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY },
    readFile: overrides.readFile ?? ((p: string) => frgFs.readFile(p)),
    resolveShipPathFromRun: overrides.resolveShipPathFromRun,
  };
}

function unsignedDigestFixture(opts?: {
  version?: string;
  candidate?: string;
  loopRunId?: string;
  packRunId?: string;
  frgRunId?: string;
}): {
  request: FactoryReleasePrepareRequest;
  unsigned: FactoryReleaseFrgPayload;
  binding: FactoryReleaseUnsignedDigestBinding;
} {
  const version = opts?.version ?? "1.40.0";
  const candidate = opts?.candidate ?? head;
  const unsigned: FactoryReleaseFrgPayload = {
    pack_id: FRG_PACK_MANIFEST.pack_id,
    manifest_path: "/pack/manifest.json",
    manifest_sha256: "1".repeat(64),
    pack_run_id: opts?.packRunId ?? "pack-1400",
    loop_run_id: opts?.loopRunId ?? "loop-frg-observe-1271",
    frg_run_id: opts?.frgRunId ?? "frg-unsigned-1400",
    evidence_created_at: "2026-08-31T00:00:00Z",
    observations: { path: "/u/obs.json", sha256: "1".repeat(64) },
    evidence_bundle: { path: "/u/bundle.json", sha256: "2".repeat(64) },
    contract: { path: "/u/contract.json", sha256: "3".repeat(64) },
    ledger: { path: "/u/ledger.json", sha256: "4".repeat(64) },
    events: { path: "/u/events.json", sha256: "5".repeat(64) },
    action_evidence: { path: "/u/action.json", sha256: "6".repeat(64) },
  };
  const request: FactoryReleasePrepareRequest = {
    schema_version: 1,
    kind: "factory_release_prepare_request",
    action_id: `pipeline-ship-${version}`,
    repository: intent.repository,
    base_branch: intent.base_branch,
    target_version: version,
    integrated_candidate: { git_sha: candidate, version: "1.39.16" },
    production_pin: { version: "1.39.16", tag: "v1.39.16", git_sha: "c".repeat(40) },
    frg_manifest: { pack_id: FRG_PACK_MANIFEST.pack_id, sha256: "1".repeat(64) },
  };
  return {
    request,
    unsigned,
    binding: buildFactoryReleaseUnsignedDigestBinding(request, unsigned),
  };
}

async function mintHybridEvidence(opts: {
  version: string;
  candidateGitSha: string;
  repository: string;
  baseBranch: string;
  factoryReleaseBinding?: unknown;
  policyId?: string;
}): Promise<FrgEvidence> {
  const pack = await loadFrgPack();
  const packRunId = "frg-pack-observe-1271";
  const loopRunId = "loop-frg-observe-1271";
  const startedAt = "2026-08-16T12:00:00.000Z";
  const rendered = renderFrgPackIssues(pack, {
    release_version: opts.version,
    pack_run_id: packRunId,
  });
  const issueNumbers = rendered.map((_, index) => 1101 + index);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const observations = collectFrgPackObservations(pack, {
    schema_version: 1 as const,
    policy_id: pack.manifest.pilot_policy.id,
    pack_id: pack.manifest.pack_id,
    manifest_version: pack.manifest.manifest_version,
    manifest_sha256: pack.manifest_sha256,
    release_version: opts.version,
    candidate_git_sha: opts.candidateGitSha,
    pack_run_id: packRunId,
    loop_run_id: loopRunId,
    repository: opts.repository,
    base_branch: opts.baseBranch,
    started_at: startedAt,
    contract: {
      artifact_sha256: digest("contract"),
      selector: { ...pack.manifest.selector },
      issue_numbers: issueNumbers,
      items: issueNumbers.map((issueNumber) => ({ issue_number: issueNumber, depends_on: [] })),
    },
    ledger: {
      artifact_sha256: digest("ledger"),
      items: issueNumbers.map((issueNumber, index) => ({
        issue_number: issueNumber,
        state: "ready",
        advance_run_id: `advance-${index + 1}`,
        blocked_theme: null,
      })),
    },
    events: {
      artifact_sha256: digest("events"),
      event_ids: issueNumbers.map((issueNumber, index) => `event:${index + 1}:item-${issueNumber}`),
      issue_numbers: issueNumbers,
    },
    action_evidence: {
      artifact_sha256: digest("actions"),
      action_ids: issueNumbers.map((issueNumber, index) => `action:${index + 1}:item-${issueNumber}`),
      issue_numbers: issueNumbers,
    },
    issues: rendered.map((issue, index) => {
      const issueNumber = issueNumbers[index]!;
      const prHead = String(index + 1).repeat(40);
      const files = issue.provenance.template_id === "clean-openspec"
        ? [
            "openspec/changes/archive/2026-08-16-frg/proposal.md",
            "openspec/specs/frg/spec.md",
          ]
        : ["docs/frg-fixture.md"];
      return {
        issue_number: issueNumber,
        issue_node_id: `ISSUE_${issueNumber}`,
        created_at: `2026-08-16T12:00:0${index + 1}.000Z`,
        title: issue.title,
        body: issue.body,
        labels: [...issue.labels, "pipeline:ready-to-deploy"],
        template_id: issue.provenance.template_id,
        template_sha256: issue.provenance.template_sha256,
        pr: {
          number: 2101 + index,
          node_id: `PR_${2101 + index}`,
          head_sha: prHead,
          base_branch: opts.baseBranch,
          files,
          checks: [
            {
              id: `CHECK_${issueNumber}`,
              name: "ci",
              head_sha: prHead,
              conclusion: "success",
            },
          ],
        },
      };
    }),
    probes: pack.manifest.pilot_policy.layer_a_probes.map((probe, index) => ({
      id: probe.id,
      candidate_git_sha: opts.candidateGitSha,
      test_file: probe.test_file,
      test_name: probe.test_name,
      command_argv_sha256: digest(`argv:${probe.id}`),
      stdout_sha256: digest(`stdout:${probe.id}`),
      stderr_sha256: digest(`stderr:${probe.id}`),
      started_at: `2026-08-16T12:01:${String(index).padStart(2, "0")}.000Z`,
      finished_at: `2026-08-16T12:01:${String(index).padStart(2, "0")}.500Z`,
    })),
  });
  const issueIds = observations.pack_provenance!.issues.map((issue) => String(issue.issue_number));
  if (opts.policyId && observations.pack_provenance) {
    observations.pack_provenance = {
      ...observations.pack_provenance,
      policy_id: opts.policyId,
    };
  }
  const evidence = computeFrgEvidence({
    version: opts.version,
    run_id: `frg-observe-${opts.version}`,
    loop_run_id: loopRunId,
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: issueIds.map((item_id) => ({ item_id, state: "ready", ready_clean: true })),
    scenario_overrides: observations.scenarios,
    composition_overrides: observations.composition,
    false_human_authority_count: observations.false_human_authority_count,
    pack_provenance: observations.pack_provenance,
    factory_release_binding: opts.factoryReleaseBinding,
    notes: [
      `Projected from durable loop run ${loopRunId}`,
      `FRG fixed pack validated: pack_id=${FRG_PACK_MANIFEST.pack_id} selector=${JSON.stringify({ type: "label", value: "factory-gate" })}`,
    ],
    score_source: "from-run",
    work_list: "factory-gate-pack",
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
    now: () => new Date("2026-08-16T12:10:00.000Z"),
    ...frgPassUniqueOperations(opts.version),
  });
  assert.equal(evidence.pass, true);
  return evidence;
}

test("ship coordinator: after (#N) observeTrain, next_action is frg_pack not train_merge (#1269)", async () => {
  const store = memoryShipStore();
  let runs = 0;
  const wrap = (deps: ReturnType<typeof shipCoordinatorDepsFromOperations>) => ({
    ...deps,
    authorizationPublicKey: "test",
    withRunLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  });
  const coordinator = wrap(shipCoordinatorDepsFromOperations(operations({
    planTrain: async () => ({ ordered_issues: [...V13914_ISSUES] }),
    observeTrain: (i, planned, candidate) =>
      observeTrainEvidence(i, planned, v13914ObserveDeps(), candidate),
    runTrain: async () => {
      runs++;
      throw new Error("issue #1258 is ready-to-deploy but has no linked open PR");
    },
    observeFrg: async () => null,
  }), { state: store }));

  const status = await runShipCoordinator(intent, null, coordinator);
  assert.match(status.last_error ?? "", /ship FRG: no release-eligible/);
  assert.equal(status.lifecycle, "cooling");
  assert.equal(runs, 0, "must not invoke runTrain");
  assert.ok(store.status?.train, "train evidence must be persisted");
  assert.equal(store.status?.train?.integrated_head_oid, V13914_MAIN);
  assert.equal(store.status?.next_action, "frg_pack");
  assert.equal(store.status?.complete, false);
});

test("observeFrg: missing latest.json for 1.39.14 returns null, not a tag-path throw (#1271)", async () => {
  const observed = await observeFrgEvidence(
    intent13914,
    train13914,
    true,
    observeFrgDeps(memFs()),
  );
  assert.equal(observed, null);
});

test("observeFrg: unreadable and pass:false latest.json return null (#1271)", async () => {
  const unreadable: FrgFsDeps = {
    ...memFs(),
    async readFile() {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    },
  };
  assert.equal(
    await observeFrgEvidence(intent13914, train13914, true, observeFrgDeps(unreadable)),
    null,
  );

  const fsDeps = memFs();
  const failEv = computeFrgEvidence({
    version: "1.39.14",
    run_id: "frg-observe-ship-fail",
    loop_run_id: "loop",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [{ item_id: "1", state: "ready", ready_clean: true }],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
  });
  assert.equal(failEv.pass, false);
  await writeFrgEvidence("/repo", failEv, fsDeps);
  assert.equal(
    await observeFrgEvidence(intent13914, train13914, true, observeFrgDeps(fsDeps)),
    null,
  );
});

test("observeFrg: release-eligible HMAC pass returns evidence; identity defects throw (#1271)", async () => {
  const matching = await mintHybridEvidence({
    version: "1.33.0",
    candidateGitSha: head,
    repository: intent.repository,
    baseBranch: intent.base_branch,
  });
  const fsPass = memFs();
  await writeFrgEvidence("/repo", matching, fsPass);
  const intent133: ShipIntent = { ...intent, version: "1.33.0", milestone: "v1.33.0" };
  const train133: ShipTrainEvidence = { ...train, milestone: "v1.33.0" };
  const observed = await observeFrgEvidence(intent133, train133, true, observeFrgDeps(fsPass));
  assert.equal(observed?.pass, true);
  assert.equal(observed?.version, "1.33.0");

  const mismatched = await mintHybridEvidence({
    version: "1.33.0",
    candidateGitSha: unrelatedOid,
    repository: intent.repository,
    baseBranch: intent.base_branch,
  });
  const fsMismatch = memFs();
  await writeFrgEvidence("/repo", mismatched, fsMismatch);
  await assert.rejects(
    () => observeFrgEvidence(intent133, train133, true, observeFrgDeps(fsMismatch)),
    /does not match the exact train candidate/,
  );

  await assert.rejects(
    () =>
      observeFrgEvidence(
        intent13914,
        train13914,
        true,
        observeFrgDeps(memFs(), { observeBase: async () => unrelatedOid }),
      ),
    /base advanced after the integrated train candidate was recorded/,
  );
  await assert.rejects(
    () =>
      observeFrgEvidence(
        intent13914,
        train13914,
        false,
        observeFrgDeps(memFs(), {
          observeBase: async () => unrelatedOid,
          isAncestor: async () => false,
        }),
      ),
    /no longer contained in base/,
  );
});

test("observeFrg: missing latest.json fail-closes when base advances during the read (#1271)", async () => {
  let reads = 0;
  await assert.rejects(
    () =>
      observeFrgEvidence(
        intent13914,
        train13914,
        true,
        observeFrgDeps(memFs(), {
          observeBase: async () => {
            reads += 1;
            return reads === 1 ? head : unrelatedOid;
          },
        }),
      ),
    /base advanced while FRG evidence was checked/,
  );
  assert.equal(reads, 2, "must re-read base after the ENOENT evidence observation");
});

test("ship coordinator: proven train + missing latest.json sets next_action frg_pack (#1271)", async () => {
  const store = memoryShipStore();
  const emptyFs = memFs();
  let packed = 0;
  const wrap = (deps: ReturnType<typeof shipCoordinatorDepsFromOperations>) => ({
    ...deps,
    authorizationPublicKey: "test",
    withRunLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  });
  const coordinator = wrap(shipCoordinatorDepsFromOperations(operations({
    planTrain: async () => ({ ordered_issues: [...train13914.ordered_issues] }),
    observeTrain: async () => train13914,
    runTrain: async () => {
      throw new Error("runTrain must not run after train is proven");
    },
    observeFrg: (i, t, requireCurrent) =>
      observeFrgEvidence(i, t, requireCurrent, observeFrgDeps(emptyFs)),
    runFrgPack: async () => {
      packed++;
    },
  }), { state: store }));

  const status = await runShipCoordinator(intent13914, null, coordinator);
  assert.equal((status.last_error ?? "").includes("Cannot create or push tag"), false, status.last_error ?? "");
  assert.match(status.last_error ?? "", /ship FRG: no release-eligible/);
  assert.equal(status.lifecycle, "cooling");
  assert.equal(packed, 1, "FRG pack must be the next mutation");
  assert.ok(store.status?.train, "train evidence must be persisted");
  assert.equal(store.status?.train?.integrated_head_oid, head);
  assert.equal(store.status?.next_action, "frg_pack");
  assert.equal(store.status?.frg_pack, null);
  assert.equal(store.status?.complete, false);
});

test("observe-null does not skip later ensure-tag; missing latest.json still fail-closes (#1271)", async () => {
  const fsDeps = memFs();
  assert.equal(
    await observeFrgEvidence(intent13914, train13914, true, observeFrgDeps(fsDeps)),
    null,
  );
  const calls: string[][] = [];
  await assert.rejects(
    () =>
      ensureAnnotatedReleaseTag({
        version: intent13914.version,
        mergeCommitOid: mergeHead,
        packedCandidate: head,
        git: missingTagGit(calls),
        validateFrg: async () =>
          (await validateFrgEvidenceSnapshotForTag("/repo", intent13914.version, fsDeps, {
            attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
          })).snapshot,
      }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /Cannot create or push tag v1\.39\.14/);
      assert.match(message, /1\.39\.14\/latest\.json/);
      return true;
    },
  );
  assert.ok(!calls.some((args) => args[0] === "tag" || args[0] === "push"));

  const matching = await mintHybridEvidence({
    version: "1.33.0",
    candidateGitSha: head,
    repository: intent.repository,
    baseBranch: intent.base_branch,
  });
  const laterFs = memFs();
  await writeFrgEvidence("/repo", matching, laterFs);
  const intent133: ShipIntent = { ...intent, version: "1.33.0", milestone: "v1.33.0" };
  const train133: ShipTrainEvidence = { ...train, milestone: "v1.33.0" };
  const later = await observeFrgEvidence(intent133, train133, true, observeFrgDeps(laterFs));
  assert.equal(later?.pass, true);
  const laterCalls: string[][] = [];
  const tagged = await ensureAnnotatedReleaseTag({
    version: "1.33.0",
    mergeCommitOid: mergeHead,
    packedCandidate: head,
    git: missingTagGit(laterCalls),
    validateFrg: async () =>
      (await validateFrgEvidenceSnapshotForTag("/repo", "1.33.0", laterFs, {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      })).snapshot,
  });
  assert.equal(tagged, "created");
  assert.ok(laterCalls.some((args) => args[0] === "tag"));
});

test("observeFrg source does not substring-match tag-path formatter copy (#1271)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "stages", "ship-adapter.ts"),
    "utf8",
  );
  const start = src.indexOf("export async function observeFrgEvidence");
  const end = src.indexOf("function realShipAdapterOperations");
  assert.ok(start !== -1 && end > start, "expected observeFrgEvidence");
  const body = src.slice(start, end);
  assert.equal(body.includes('includes("evidence missing")'), false);
  assert.equal(body.includes("includes('evidence missing')"), false);
  assert.equal(
    /message\.includes\s*\(/.test(body),
    false,
    "observeFrg must not classify by formatter substring",
  );
  assert.match(body, /observeReleaseEligibleFrgEvidence/);
});

test("ship adapter returns the one frozen train plan from its planning seam", async () => {
  const deps = shipCoordinatorDepsFromOperations(operations({
    planTrain: async () => ({ ordered_issues: [11, 10] }),
  }), { state });

  assert.deepEqual(await deps.planTrain(intent), { ordered_issues: [11, 10] });
});

test("ensureAnnotatedReleaseTag creates and pushes when FRG is eligible and tag is missing (#1115)", async () => {
  const calls: string[][] = [];
  const git = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args.includes("--verify")) return mergeHead;
    if (args[0] === "cat-file") throw new Error("not a valid object");
    if (args[0] === "fetch") throw new Error("couldn't find remote ref");
    return "";
  };
  let validated = 0;
  const result = await ensureAnnotatedReleaseTag({
    version: "1.34.0",
    mergeCommitOid: mergeHead,
    packedCandidate: head,
    git,
    validateFrg: async () => {
      validated++;
      return hmacSnapshot(head);
    },
  });
  assert.equal(result, "created");
  assert.equal(validated, 1);
  assert.ok(calls.some((args) => args[0] === "tag" && args[1] === "-a" && args[2] === "v1.34.0" && args[3] === mergeHead));
  assert.ok(calls.some((args) => args[0] === "push" && args.includes("refs/tags/v1.34.0")));
  assert.ok(!calls.some((args) => args.includes("-f") || args.includes("--force")));
});

test("ensureAnnotatedReleaseTag is a no-op when origin already has the annotated tag (#1115)", async () => {
  const calls: string[][] = [];
  const git = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args.includes("--verify")) return mergeHead;
    if (args[0] === "fetch") return "";
    if (args[0] === "cat-file") return "tag";
    if (args[0] === "rev-parse") return mergeHead;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const result = await ensureAnnotatedReleaseTag({
    version: "1.34.0",
    mergeCommitOid: mergeHead,
    packedCandidate: head,
    git,
    validateFrg: async () => {
      throw new Error("must not re-validate when origin tag exists");
    },
  });
  assert.equal(result, "exists");
  assert.ok(calls.some((args) => args[0] === "fetch"));
  assert.ok(!calls.some((args) => args[0] === "push" || args[0] === "tag"));
});

test("ship adapter fails closed with the exact existing FRG next action", async () => {
  const deps = shipCoordinatorDepsFromOperations(operations({
    observeFrg: async () => null,
  }), { state });

  await assert.rejects(
    deps.convergeFrgPack(intent, train),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /pipeline loop --label factory-gate --profile claude/);
      assert.match(msg, /pipeline factory-gate --for 1\.34\.0 --from-run/);
      assert.match(
        msg,
        /pipeline factory-release prepare --request <absolute-off-repo-request\.json> --json/,
      );
      const loopIdx = msg.indexOf("pipeline loop --label factory-gate --profile claude");
      const prepareIdx = msg.indexOf("pipeline factory-release prepare");
      assert.ok(loopIdx !== -1 && loopIdx < prepareIdx, "prepare must not replace loop + profile");
      assert.doesNotMatch(msg, /non-claude[\s\S]*--skip-frg|--skip-frg[\s\S]*non-claude/);
      return true;
    },
  );
});

test("planTrainFromMilestoneIssues: all-closed R2D freezes instead of no-open-issues (#1252)", () => {
  const issues: TrainIssueSnapshot[] = [
    {
      number: 10,
      title: "done",
      body: "",
      labels: ["pipeline:ready-to-deploy"],
      state: "closed",
    },
    {
      number: 11,
      title: "also done",
      body: "Depends on: #10",
      labels: ["pipeline:ready-to-deploy"],
      state: "closed",
    },
  ];
  const plan = planTrainFromMilestoneIssues("v1.39.13", issues);
  assert.deepEqual(plan.ordered_issues, [10, 11]);
});

test("planTrainFromMilestoneIssues: mixed open + closed R2D stay in one freeze plan (#1252)", () => {
  const issues: TrainIssueSnapshot[] = [
    {
      number: 20,
      title: "open r2d",
      body: "",
      labels: ["pipeline:ready-to-deploy"],
      state: "open",
    },
    {
      number: 21,
      title: "closed r2d",
      body: "",
      labels: ["pipeline:ready-to-deploy"],
      state: "closed",
    },
    {
      number: 22,
      title: "cancelled",
      body: "",
      labels: [],
      state: "closed",
    },
  ];
  const plan = planTrainFromMilestoneIssues("v1.39.13", issues);
  assert.deepEqual([...plan.ordered_issues].sort((a, b) => a - b), [20, 21]);
});

test("ship adapter remaining-open leftover blocks FRG pack without real gh (#1354)", async () => {
  const store = memoryShipStore();
  let frgPackRuns = 0;
  const deps = shipCoordinatorDepsFromOperations(
    operations({
      observeRemainingOpenMilestoneIssues: async () => [1344],
      runFrgPack: async () => {
        frgPackRuns += 1;
      },
      observeFrg: async () => {
        throw new Error("observeFrg must not run when remaining-open fails");
      },
    }),
    { state: store, authorizationPublicKey: "test" },
  );
  const coordinator = {
    ...deps,
    withRunLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  };
  const status = await runShipCoordinator(intent, null, coordinator);
  assert.match(status.last_error ?? "", /milestone v1\.34\.0 still has open issues: #1344/);
  assert.equal(status.lifecycle, "waiting");
  assert.equal(frgPackRuns, 0);
  assert.ok(store.status?.train, "train must still complete");
  assert.equal(store.status?.frg_pack, null);
});

test("ship-adapter remaining-open listing reuses merge-queue helpers, not freeze --limit (#1354)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../scripts/stages/ship-adapter.ts"),
    "utf8",
  );
  assert.match(src, /listRemainingOpenMilestoneIssueNumbers/);
  assert.match(src, /observeRemainingOpenMilestoneIssues/);
  const freezeIdx = src.indexOf("MILESTONE_ISSUE_DISCOVERY_LIMIT");
  const remainingIdx = src.indexOf("listRemainingOpenMilestoneIssueNumbers");
  assert.ok(freezeIdx !== -1 && remainingIdx !== -1);
  assert.notEqual(
    remainingIdx,
    freezeIdx,
    "remaining-open must not reuse the freeze discovery limit listing",
  );
});

test("planTrainFromMilestoneIssues: empty freeze-eligible fails closed, not open-only (#1252)", () => {
  assert.throws(
    () => planTrainFromMilestoneIssues("v-empty", []),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /no freeze-eligible issues/);
      assert.doesNotMatch(msg, /no open issues/);
      return true;
    },
  );
  assert.throws(
    () =>
      planTrainFromMilestoneIssues("v-cancelled", [
        { number: 1, title: "x", body: "", labels: [], state: "closed" },
      ]),
    /no freeze-eligible issues/,
  );
});

test("shipMissingFrgDiagnostic names pack loop, profile, and from-run (#1252)", () => {
  const text = shipMissingFrgDiagnostic({ version: "1.39.13" });
  assert.match(text, /pipeline loop --label factory-gate --profile claude/);
  assert.match(text, /pipeline factory-gate --for 1\.39\.13 --from-run/);
  assert.doesNotMatch(text, /^[\s\S]*Run: pipeline factory-gate --for 1\.39\.13\s*$/);
  const withPrepare = shipMissingFrgDiagnostic({
    version: "1.39.13",
    includePrepare: true,
  });
  const loopIdx = withPrepare.indexOf("pipeline loop --label factory-gate --profile claude");
  const fromRunIdx = withPrepare.indexOf("pipeline factory-gate --for 1.39.13 --from-run");
  const prepareIdx = withPrepare.indexOf("pipeline factory-release prepare");
  assert.ok(loopIdx !== -1 && fromRunIdx !== -1 && prepareIdx !== -1);
  assert.ok(loopIdx < prepareIdx && fromRunIdx < prepareIdx);
  assert.ok(!withPrepare.includes("--skip-frg") || withPrepare.lastIndexOf("--skip-frg") > fromRunIdx);
});

test("ship adapter accepts post-pilot hybrid-v2 with matching checkpoint; refuses index-only and hybrid-v1 (#1340)", () => {
  const fixture = unsignedDigestFixture({ version: intent.version, candidate: train.integrated_head_oid });
  assert.throws(
    () => assertFrgCandidateProvenance(frg, train, intent),
    /no pack_provenance/,
  );
  assert.throws(
    () => assertFrgCandidateProvenance(frg, train, intent, {
      closedUnsignedBinding: fixture.binding,
    }),
    /no pack_provenance/,
  );

  const hybridV2 = {
    ...frg,
    pack_provenance: {
      policy_id: FRG_HYBRID_V2_POLICY_ID,
      candidate_git_sha: train.integrated_head_oid,
      repository: intent.repository,
      base_branch: intent.base_branch,
    },
    factory_release_binding: fixture.binding,
  } as unknown as FrgEvidence;
  assert.doesNotThrow(() =>
    assertFrgCandidateProvenance(hybridV2, train, intent, {
      closedUnsignedBinding: fixture.binding,
    }),
  );

  const hybridV1 = {
    ...hybridV2,
    pack_provenance: {
      policy_id: FRG_HYBRID_PILOT_POLICY_ID,
      candidate_git_sha: train.integrated_head_oid,
      repository: intent.repository,
      base_branch: intent.base_branch,
    },
  } as unknown as FrgEvidence;
  assert.throws(
    () => assertFrgCandidateProvenance(hybridV1, train, intent, {
      closedUnsignedBinding: fixture.binding,
    }),
    /factory-gate-v1-hybrid-v1/,
  );

  const unknownPolicy = {
    ...hybridV2,
    pack_provenance: {
      policy_id: "factory-gate-v1-hybrid-v9",
      candidate_git_sha: train.integrated_head_oid,
      repository: intent.repository,
      base_branch: intent.base_branch,
    },
  } as unknown as FrgEvidence;
  assert.throws(
    () => assertFrgCandidateProvenance(unknownPolicy, train, intent, {
      closedUnsignedBinding: fixture.binding,
    }),
    /factory-gate-v1-hybrid-v9/,
  );

  assert.throws(
    () => assertFrgCandidateProvenance({
      ...hybridV2,
      factory_release_binding: undefined,
    } as FrgEvidence, train, intent, { closedUnsignedBinding: fixture.binding }),
    /factory_release_binding/,
  );
  assert.throws(
    () => assertFrgCandidateProvenance({
      ...hybridV2,
      factory_release_binding: "notes-only",
    } as FrgEvidence, train, intent, { closedUnsignedBinding: fixture.binding }),
    /factory_release_binding/,
  );

  const mismatchedBinding = {
    ...fixture.binding,
    candidate_git_sha: "f".repeat(40),
  };
  assert.throws(
    () => assertFrgCandidateProvenance({
      ...hybridV2,
      factory_release_binding: mismatchedBinding,
    } as FrgEvidence, train, intent, { closedUnsignedBinding: fixture.binding }),
    /factory_release_binding\.candidate_git_sha mismatch/,
  );

  const mismatched = {
    ...frg,
    pack_provenance: {
      policy_id: FRG_HYBRID_V2_POLICY_ID,
      candidate_git_sha: "f".repeat(40),
      repository: intent.repository,
      base_branch: intent.base_branch,
    },
  } as unknown as FrgEvidence;
  assert.throws(
    () => assertFrgCandidateProvenance(mismatched, train, {
      ...intent,
      version: "1.33.0",
    }),
    /does not match the exact train candidate/,
  );
});

test("observeFrg: v1.40.0 and v1.39.16 hybrid-v2 with matching checkpoint are observed (#1340)", async () => {
  for (const version of ["1.40.0", "1.39.16"] as const) {
    const fixture = unsignedDigestFixture({
      version,
      candidate: head,
      loopRunId: "loop-frg-observe-1271",
    });
    const matching = await mintHybridEvidence({
      version,
      candidateGitSha: head,
      repository: intent.repository,
      baseBranch: intent.base_branch,
      factoryReleaseBinding: fixture.binding,
      policyId: FRG_HYBRID_V2_POLICY_ID,
    });
    assert.equal(matching.pack_provenance?.policy_id, FRG_HYBRID_V2_POLICY_ID);
    const fsPass = memFs();
    await writeFrgEvidence("/repo", matching, fsPass);
    const shipIntent: ShipIntent = { ...intent, version, milestone: `v${version}` };
    const shipTrain: ShipTrainEvidence = { ...train, milestone: `v${version}` };
    const observed = await observeFrgEvidence(
      shipIntent,
      shipTrain,
      true,
      observeFrgDeps(fsPass, {
        resolveShipPathFromRun: async () => ({
          kind: "bound",
          binding: fixture.binding,
          unsigned_frg_run_id: fixture.unsigned.frg_run_id,
        }),
      }),
    );
    assert.equal(observed?.pass, true);
    assert.equal(observed?.version, version);
    assert.equal(observed?.pack_provenance?.candidate_git_sha, head);
  }
});

test("observeFrg: missing closed checkpoint after post-pilot eligible read throws (#1340)", async () => {
  const fixture = unsignedDigestFixture({ version: "1.40.0", candidate: head });
  const matching = await mintHybridEvidence({
    version: "1.40.0",
    candidateGitSha: head,
    repository: intent.repository,
    baseBranch: intent.base_branch,
    factoryReleaseBinding: fixture.binding,
    policyId: FRG_HYBRID_V2_POLICY_ID,
  });
  const fsPass = memFs();
  await writeFrgEvidence("/repo", matching, fsPass);
  const intent140: ShipIntent = { ...intent, version: "1.40.0", milestone: "v1.40.0" };
  const train140: ShipTrainEvidence = { ...train, milestone: "v1.40.0" };
  await assert.rejects(
    () =>
      observeFrgEvidence(
        intent140,
        train140,
        true,
        observeFrgDeps(fsPass, {
          resolveShipPathFromRun: async () => ({ kind: "standalone" }),
        }),
      ),
    /no closed unsigned checkpoint/,
  );
});

test("ship adapter re-observes the candidate before release prepare", async () => {
  let prepared = false;
  const deps = shipCoordinatorDepsFromOperations(operations({
    observeRelease: async () => null,
    observeTrain: async () => ({
      ...train,
      integrated_head_oid: "e".repeat(40),
    }),
    prepareRelease: async () => {
      prepared = true;
      return release;
    },
  }), { state });

  await assert.rejects(
    deps.convergeReleasePrepare(intent, {
      version: intent.version,
      pass: true,
      loop_run_id: "loop-1",
      frg_run_id: "frg-1",
      candidate_head_oid: head,
    }),
    /base changed after FRG/,
  );
  assert.equal(prepared, false);
});

test("ship adapter accepts already completed release, publication, and promotion truth", async () => {
  const calls: string[] = [];
  const deps = shipCoordinatorDepsFromOperations(operations({
    finishRelease: async () => {
      calls.push("finish");
      return releaseFinish;
    },
    waitForPublication: async () => {
      calls.push("wait");
      return publication;
    },
    promote: async () => {
      calls.push("promote");
      return promotion;
    },
  }), { state });

  await deps.convergeTrain(intent, train.ordered_issues);
  assert.deepEqual(await deps.convergeReleaseFinish(intent, release), releaseFinish);
  assert.deepEqual(await deps.waitForRelease(intent, releaseFinish), publication);
  assert.deepEqual(await deps.convergeEnginePromote(intent, publication), promotion);
  assert.deepEqual(await deps.convergeDeployment(intent, promotion), deployment);
  assert.deepEqual(calls, []);
});

const TEST_FAIL_LINK = "https://github.com/o/r/actions/runs/32075787450";

function memoryWait(
  over: Partial<ShipReleaseCheckWaitDeps> & {
    getPrChecks: ShipReleaseCheckWaitDeps["getPrChecks"];
  },
): ShipReleaseCheckWaitDeps {
  let doc = emptyRerunBudgetDoc();
  return {
    rerunFailedWorkflows: async () => ({ attempted: true, runIds: ["32075787450"] }),
    sleep: async () => {},
    loadAttemptCount: async (pr, headSha) => attemptCountFor(doc, pr, headSha),
    recordAttempt: async (pr, headSha, runId) => {
      doc = withRecordedAttempt(doc, pr, headSha, runId, "2026-08-21T00:00:00.000Z");
    },
    maxAttempts: 3,
    intervalMs: 0,
    rerunBudget: 1,
    ...over,
  };
}

test("convergeReleaseFinish does not invoke finish while checks are pending (#1205)", async () => {
  let finishes = 0;
  let checks = 0;
  const deps = shipCoordinatorDepsFromOperations(operations({
    observeRelease: async () => ({ prepare: release, finish: null }),
    finishRelease: async () => {
      finishes++;
      return releaseFinish;
    },
  }), {
    state,
    releaseCheckWait: memoryWait({
      maxAttempts: 2,
      getPrChecks: async () => {
        checks++;
        return [{ name: "test", state: "PENDING", bucket: "pending", link: "" }];
      },
    }),
  });
  await deps.convergeTrain(intent, train.ordered_issues);
  await assert.rejects(
    () => deps.convergeReleaseFinish(intent, release),
    (err: unknown) => {
      assert.ok(err instanceof ShipReleaseCheckWaitError);
      assert.equal(err.outcome, "pending");
      assert.doesNotMatch(err.message, /observable checks are not green/);
      return true;
    },
  );
  assert.equal(finishes, 0, "finish must not run on a pending snapshot");
  assert.ok(checks >= 1, "waiter must poll gh pr checks");
});

test("convergeReleaseFinish requests gh run rerun --failed for a flake test fail before a second wait (#1205)", async () => {
  const calls: string[] = [];
  let finishes = 0;
  const captures = [
    [{ name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK }],
    [{ name: "test", state: "PENDING", bucket: "pending", link: TEST_FAIL_LINK }],
  ];
  const deps = shipCoordinatorDepsFromOperations(operations({
    observeRelease: async () => ({ prepare: release, finish: null }),
    finishRelease: async () => {
      finishes++;
      calls.push("finish");
      return releaseFinish;
    },
  }), {
    state,
    releaseCheckWait: memoryWait({
      maxAttempts: 2,
      getPrChecks: async () => {
        calls.push("checks");
        return captures.shift() ?? [{ name: "test", state: "PENDING", bucket: "pending" }];
      },
      rerunFailedWorkflows: async () => {
        calls.push("rerun");
        return { attempted: true, runIds: ["32075787450"] };
      },
      sleep: async () => {
        calls.push("sleep");
      },
    }),
  });
  await deps.convergeTrain(intent, train.ordered_issues);
  await assert.rejects(
    () => deps.convergeReleaseFinish(intent, release),
    (err: unknown) => {
      assert.ok(err instanceof ShipReleaseCheckWaitError);
      assert.equal(err.outcome, "pending");
      return true;
    },
  );
  assert.equal(finishes, 0);
  assert.ok(calls.includes("rerun"), "flake-eligible test fail must request gh run rerun --failed");
  assert.ok(calls.indexOf("rerun") < calls.lastIndexOf("checks"), "rerun must happen before the second wait");
  assert.ok(!calls.includes("finish"));
});

test("convergeReleaseFinish invokes finish only after green checks (#1205)", async () => {
  let finishes = 0;
  const captures = [
    [{ name: "test", state: "PENDING", bucket: "pending" }],
    [{ name: "test", state: "SUCCESS", bucket: "pass" }],
  ];
  const deps = shipCoordinatorDepsFromOperations(operations({
    observeRelease: async () => ({ prepare: release, finish: null }),
    finishRelease: async () => {
      finishes++;
      return releaseFinish;
    },
  }), {
    state,
    releaseCheckWait: memoryWait({
      maxAttempts: 5,
      getPrChecks: async () => captures.shift() ?? [{ name: "test", state: "SUCCESS", bucket: "pass" }],
    }),
  });
  await deps.convergeTrain(intent, train.ordered_issues);
  assert.deepEqual(await deps.convergeReleaseFinish(intent, release), releaseFinish);
  assert.equal(finishes, 1);
  assert.equal(captures.length, 0);
});

test("convergeReleaseFinish persists fail without finish on a terminal product fail (#1205)", async () => {
  let finishes = 0;
  let reruns = 0;
  const deps = shipCoordinatorDepsFromOperations(operations({
    observeRelease: async () => ({ prepare: release, finish: null }),
    finishRelease: async () => {
      finishes++;
      return releaseFinish;
    },
  }), {
    state,
    releaseCheckWait: memoryWait({
      getPrChecks: async () => [
        { name: "release-build", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK },
      ],
      rerunFailedWorkflows: async () => {
        reruns++;
        return { attempted: true, runIds: ["32075787450"] };
      },
    }),
  });
  await deps.convergeTrain(intent, train.ordered_issues);
  await assert.rejects(
    () => deps.convergeReleaseFinish(intent, release),
    (err: unknown) => {
      assert.ok(err instanceof ShipReleaseCheckWaitError);
      assert.equal(err.outcome, "fail");
      assert.match(err.message, /non-flake product fail/);
      return true;
    },
  );
  assert.equal(finishes, 0);
  assert.equal(reruns, 0);
});

test("coordinator wait-cap expiry keeps release_finish resumable (#1205)", async () => {
  const store = memoryShipStore();
  store.status = checkpoint({
    ship_key: shipKey(intent),
    next_action: "release_finish",
    train,
    train_plan: { ordered_issues: [...train.ordered_issues] },
    frg_pack: {
      version: intent.version,
      complete: true,
      loop_run_id: "loop-1",
      pack_id: "factory-gate-v1",
      candidate_head_oid: head,
    },
    frg: {
      version: intent.version,
      pass: true,
      loop_run_id: "loop-1",
      frg_run_id: "frg-1",
      candidate_head_oid: head,
    },
    release,
  });
  let finishes = 0;
  let checks = 0;
  const pendingWait = memoryWait({
    maxAttempts: 2,
    getPrChecks: async () => {
      checks++;
      return [{ name: "test", state: "PENDING", bucket: "pending", link: "" }];
    },
  });
  const wrap = (deps: ReturnType<typeof shipCoordinatorDepsFromOperations>) => ({
    ...deps,
    authorizationPublicKey: "test",
    withRunLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  });
  const waiting = wrap(shipCoordinatorDepsFromOperations(operations({
    observeRelease: async () => ({ prepare: release, finish: null }),
    finishRelease: async () => {
      finishes++;
      return releaseFinish;
    },
  }), {
    state: store,
    releaseCheckWait: pendingWait,
  }));
  const checkpointed = await runShipCoordinator(intent, null, waiting);
  assert.equal(checkpointed.complete, false);
  assert.equal(checkpointed.next_action, "release_finish");
  assert.equal(checkpointed.last_error, null);
  assert.equal(checkpointed.release_finish, null);
  assert.equal(finishes, 0);
  assert.equal(checks, 2);
  assert.ok(!store.events.some((event) => event.status === "failed"));

  checks = 0;
  const greenWait = memoryWait({
    maxAttempts: 2,
    getPrChecks: async () => {
      checks++;
      return [{ name: "test", state: "SUCCESS", bucket: "pass" }];
    },
  });
  const resumed = wrap(shipCoordinatorDepsFromOperations(operations({
    observeRelease: async () => ({ prepare: release, finish: null }),
    finishRelease: async () => {
      finishes++;
      return releaseFinish;
    },
  }), {
    state: store,
    releaseCheckWait: greenWait,
  }));
  const result = await runShipCoordinator(intent, null, resumed);
  assert.equal(result.complete, true);
  assert.equal(result.next_action, "complete");
  assert.equal(result.last_error, null);
  assert.equal(finishes, 1);
  assert.equal(checks, 1);
});

test("convergeReleaseFinish does not rerun or finish when the release PR head changes during wait (#1205)", async () => {
  const changed = { ...release, head_oid: "f".repeat(40) };
  let observes = 0;
  let finishes = 0;
  let reruns = 0;
  const captures = [
    [{ name: "test", state: "PENDING", bucket: "pending", link: "" }],
    [{ name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK }],
  ];
  const deps = shipCoordinatorDepsFromOperations(operations({
    observeRelease: async () => {
      observes++;
      if (observes >= 3) return { prepare: changed, finish: null };
      return { prepare: release, finish: null };
    },
    finishRelease: async () => {
      finishes++;
      return releaseFinish;
    },
  }), {
    state,
    releaseCheckWait: memoryWait({
      maxAttempts: 5,
      getPrChecks: async () => captures.shift() ?? [{ name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK }],
      rerunFailedWorkflows: async () => {
        reruns++;
        return { attempted: true, runIds: ["32075787450"] };
      },
    }),
  });
  await deps.convergeTrain(intent, train.ordered_issues);
  await assert.rejects(
    () => deps.convergeReleaseFinish(intent, release),
    (err: unknown) => {
      assert.ok(err instanceof ShipReleaseCheckWaitError);
      assert.equal(err.outcome, "pending");
      assert.match(err.message, /head changed during wait/);
      return true;
    },
  );
  assert.equal(finishes, 0, "must not finish under a stale prepared head");
  assert.equal(reruns, 0, "must not rerun workflows for a changed head");
});

test("convergeReleaseFinish does not finish when the release PR head changes after green checks (#1205)", async () => {
  const changed = { ...release, head_oid: "f".repeat(40) };
  let observes = 0;
  let finishes = 0;
  const deps = shipCoordinatorDepsFromOperations(operations({
    observeRelease: async () => {
      observes++;
      if (observes >= 3) return { prepare: changed, finish: null };
      return { prepare: release, finish: null };
    },
    finishRelease: async () => {
      finishes++;
      return releaseFinish;
    },
  }), {
    state,
    releaseCheckWait: memoryWait({
      maxAttempts: 5,
      getPrChecks: async () => [{ name: "test", state: "SUCCESS", bucket: "pass" }],
    }),
  });
  await deps.convergeTrain(intent, train.ordered_issues);
  await assert.rejects(
    () => deps.convergeReleaseFinish(intent, release),
    (err: unknown) => {
      assert.ok(err instanceof ShipReleaseCheckWaitError);
      assert.equal(err.outcome, "pending");
      assert.match(err.message, /head changed during wait/);
      return true;
    },
  );
  assert.equal(finishes, 0);
});

test("loadRerunAttemptCount treats unreadable budget state as exhausted so no extra rerun is issued (#1205)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-rerun-budget-"));
  const budgetFile = path.join(dir, "release-checks.rerun.json");
  fs.writeFileSync(budgetFile, "{ \"schema_version\": 1, \"entries\": [");
  try {
    assert.equal(
      await loadRerunAttemptCount(budgetFile, 945, releaseHead),
      MAX_RERUN_BUDGET,
      "malformed persisted state must fail closed",
    );
    let reruns = 0;
    let finishes = 0;
    const deps = shipCoordinatorDepsFromOperations(operations({
      observeRelease: async () => ({ prepare: release, finish: null }),
      finishRelease: async () => {
        finishes++;
        return releaseFinish;
      },
    }), {
      state,
      releaseCheckWait: memoryWait({
        loadAttemptCount: (pr, headSha) => loadRerunAttemptCount(budgetFile, pr, headSha),
        recordAttempt: (pr, headSha, runId) =>
          recordRerunAttemptFile(budgetFile, pr, headSha, runId, "2026-08-21T00:00:00.000Z"),
        getPrChecks: async () => [
          { name: "test", state: "FAILURE", bucket: "fail", link: TEST_FAIL_LINK },
        ],
        rerunFailedWorkflows: async () => {
          reruns++;
          return { attempted: true, runIds: ["32075787450"] };
        },
      }),
    });
    await deps.convergeTrain(intent, train.ordered_issues);
    await assert.rejects(
      () => deps.convergeReleaseFinish(intent, release),
      (err: unknown) => {
        assert.ok(err instanceof ShipReleaseCheckWaitError);
        assert.equal(err.outcome, "fail");
        assert.match(err.message, /rerun budget spent/);
        return true;
      },
    );
    assert.equal(reruns, 0, "malformed budget must not issue another rerun");
    assert.equal(finishes, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recordRerunAttemptFile writes through temp+rename and refuses to reset unreadable state (#1205)", async () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../scripts/stages/ship-adapter.ts"),
    "utf8",
  );
  const start = src.indexOf("async function writeRerunBudgetAtomic");
  const next = src.indexOf("\nexport async function loadRerunAttemptCount");
  assert.ok(start !== -1 && next !== -1 && start < next);
  const body = src.slice(start, next);
  assert.match(body, /rename/);
  assert.match(body, /\.tmp/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-rerun-budget-write-"));
  const budgetFile = path.join(dir, "release-checks.rerun.json");
  try {
    await recordRerunAttemptFile(budgetFile, 945, releaseHead, "32075787450", "2026-08-21T00:00:00.000Z");
    assert.equal(await loadRerunAttemptCount(budgetFile, 945, releaseHead), 1);
    fs.writeFileSync(budgetFile, "{ truncated");
    await assert.rejects(
      () => recordRerunAttemptFile(budgetFile, 945, releaseHead, "1", "2026-08-21T00:00:01.000Z"),
      /unreadable rerun-budget state/,
    );
    assert.equal(fs.readFileSync(budgetFile, "utf8"), "{ truncated");
    assert.equal(await loadRerunAttemptCount(budgetFile, 945, releaseHead), MAX_RERUN_BUDGET);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("convergeReleaseFinish skips wait when finish evidence is already observed (#1205)", async () => {
  let checks = 0;
  let finishes = 0;
  const deps = shipCoordinatorDepsFromOperations(operations({
    finishRelease: async () => {
      finishes++;
      return releaseFinish;
    },
  }), {
    state,
    releaseCheckWait: memoryWait({
      getPrChecks: async () => {
        checks++;
        return [{ name: "test", state: "PENDING", bucket: "pending" }];
      },
    }),
  });
  await deps.convergeTrain(intent, train.ordered_issues);
  assert.deepEqual(await deps.convergeReleaseFinish(intent, release), releaseFinish);
  assert.equal(checks, 0);
  assert.equal(finishes, 0);
});

test("ship publication accepts only an annotated tag peeled to the release merge", async () => {
  const calls: string[] = [];
  await verifyAnnotatedReleaseTag("v1.34.0", mergeHead, async (args) => {
    calls.push(args.join(" "));
    return args[0] === "cat-file" ? "tag" : mergeHead;
  });
  assert.deepEqual(calls, [
    "cat-file -t refs/tags/v1.34.0",
    "rev-parse refs/tags/v1.34.0^{}",
  ]);

  await assert.rejects(
    verifyAnnotatedReleaseTag("v1.34.0", mergeHead, async () => "commit"),
    /must be an annotated tag/,
  );
  await assert.rejects(
    verifyAnnotatedReleaseTag("v1.34.0", mergeHead, async (args) =>
      args[0] === "cat-file" ? "tag" : "d".repeat(40)),
    /does not point to the release merge commit/,
  );
});

test("ship release checkout is fast-forwarded and must equal the FRG candidate", async () => {
  const calls: string[] = [];
  await alignReleaseCheckoutToCandidate("main", head, async (args) => {
    calls.push(args.join(" "));
    return args[0] === "rev-parse" ? head : "";
  });
  assert.deepEqual(calls, ["checkout main", "merge --ff-only origin/main", "rev-parse HEAD"]);

  await assert.rejects(
    alignReleaseCheckoutToCandidate("main", head, async (args) =>
      args[0] === "rev-parse" ? "f".repeat(40) : ""),
    /does not match the FRG candidate/,
  );
});

test("production ship adapter wires multi-item advanceWave, not N×single (review 2 b09c0a25)", () => {
  const shipAdapter = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "stages", "ship-adapter.ts"),
    "utf8",
  );
  // Strip comments so a doc mention of the forbidden helper cannot false-fail.
  const shipCode = shipAdapter
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.ok(
    !shipCode.includes("advanceWaveFromSingle"),
    "ship-adapter production path must not convert frontiers to N×single via advanceWaveFromSingle",
  );
  assert.ok(
    shipCode.includes("advanceWave: opts.advanceWave"),
    "ship-adapter must pass the injected multi-item advanceWave into realTrainDeps",
  );
  assert.ok(
    /advanceWave\s*\(\s*issues:\s*readonly number\[\]\s*\)/.test(shipCode),
    "RealShipCoordinatorDepsOptions must require multi-item advanceWave",
  );

  const pipeline = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "pipeline.ts"),
    "utf8",
  );
  const shipBlockStart = pipeline.indexOf("realShipCoordinatorDeps({");
  assert.ok(shipBlockStart !== -1, "pipeline ship path must construct realShipCoordinatorDeps");
  const shipBlock = pipeline.slice(shipBlockStart, shipBlockStart + 800);
  assert.ok(
    shipBlock.includes("advanceWaveThroughLoop"),
    "pipeline ship must wire advanceWaveThroughLoop (same multi-item loop wave as runTrainCommand)",
  );
  assert.ok(
    !shipBlock.includes("advanceIssueThroughSingle") && !shipBlock.includes("advanceWaveFromSingle"),
    "pipeline ship must not wire N×single advance into the train production adapter",
  );
});

const PIN_SHA = "9".repeat(40);
const candidateEngine = {
  engineRoot: "/cand",
  launcherPath: "/cand/scripts/pipeline-launcher.mjs",
  commitSha: head,
};

function memoryShipStore(): ShipStateStore & { status: ShipStatus | null; events: ShipPhaseEvent[] } {
  let status: ShipStatus | null = null;
  const events: ShipPhaseEvent[] = [];
  return {
    get status() { return status; },
    set status(value) { status = value; },
    events,
    statusFile: () => "/state/status.json",
    eventsFile: () => "/state/events.jsonl",
    read: async () => status,
    writeAtomic: async (_key, value) => {
      status = value;
    },
    appendEvent: async (_key, event) => {
      events.push(event);
    },
  };
}

test("pin SHA ≠ candidate: post-train prepare/release/tag spawn candidate launcher, not in-process pin", async () => {
  const spawned: string[][] = [];
  let preparedInProcess = false;
  let taggedInProcess = false;
  let gated = false;
  const pinOps = operations({
    observeRelease: async () => ({ prepare: release, finish: null }),
    prepareRelease: async () => {
      preparedInProcess = true;
      return release;
    },
    waitForPublication: async () => {
      taggedInProcess = true;
      return publication;
    },
  });
  const bound = bindCandidateShipEndOperations(pinOps, {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: { PIPELINE_FRG_ATTESTATION_KEY: "secret" },
    nodeBin: "/usr/bin/node",
    factoryReleaseRequestPath: "/abs/req.json",
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv, env) => {
      spawned.push(argv);
      // Prepare must stay uncredentialed (#1133). The attestor child inherits KEY.
      if (argv.includes("factory-release")) {
        assert.equal(env.PIPELINE_FRG_ATTESTATION_KEY, undefined);
        if (gated) {
          return { code: 0, stdout: JSON.stringify({ status: "complete" }), stderr: "" };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            status: "awaiting_frg_attestation",
            frg: { loop_run_id: "loop-1" },
          }),
          stderr: "",
        };
      }
      if (argv.includes("factory-gate")) gated = true;
      assert.ok(!argv.includes("ship"));
      assert.ok(!argv.includes("train"));
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  await bound.runFrgPack!(intent, train);
  await bound.prepareRelease(intent, head);
  await bound.waitForPublication(intent, releaseFinish);
  assert.equal(preparedInProcess, false);
  assert.equal(taggedInProcess, false);
  assert.ok(spawned.some((argv) => argv.includes("factory-release") && argv.includes("/cand/scripts/pipeline-launcher.mjs")));
  assert.ok(spawned.some((argv) => argv.includes("factory-gate") && argv.includes("--from-run")));
  assert.ok(spawned.some((argv) => argv[argv.length - 2] === "release" || argv.includes("release")));
  assert.ok(
    spawned.some((argv) =>
      argv.includes("ensure-tag") &&
      argv.includes(intent.version) &&
      argv.includes(mergeHead) &&
      argv.includes("/cand/scripts/pipeline-launcher.mjs")
    ),
    "tag must spawn candidate release ensure-tag, not pin-process ensureAnnotatedReleaseTag",
  );
  for (const argv of spawned) {
    assert.equal(argv[0], "/usr/bin/node");
    assert.equal(argv[1], "/cand/scripts/pipeline-launcher.mjs");
  }
});

test("unresolvable candidate stops ship before FRG and leaves train evidence", async () => {
  const store = memoryShipStore();
  store.status = checkpoint({
    ship_key: shipKey(intent),
    next_action: "frg_pack",
    train,
    train_plan: { ordered_issues: [...train.ordered_issues] },
  });
  let preparedInProcess = false;
  const bound = bindCandidateShipEndOperations(operations({
    observeFrg: async () => null,
    prepareRelease: async () => {
      preparedInProcess = true;
      return release;
    },
  }), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: {},
    factoryReleaseRequestPath: "/abs/req.json",
    resolveCandidate: async () => ({ ok: false, error: "no checkout at candidate SHA" }),
    spawn: async () => {
      throw new Error("spawn must not run");
    },
  });
  const deps = shipCoordinatorDepsFromOperations(bound, { state: store });
  const wrapped = {
    ...deps,
    authorizationPublicKey: "test",
    withRunLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  };
  const status = await runShipCoordinator(intent, null, wrapped);
  assert.match(status.last_error ?? "", /candidate-engine identity defect/);
  assert.equal(status.lifecycle, "cooling");
  assert.equal(preparedInProcess, false);
  assert.equal(store.status?.train?.integrated_head_oid, head);
  assert.equal(store.status?.frg_pack, null);
  assert.match(store.status?.last_error ?? "", /candidate-engine identity defect/);
  assert.equal(store.status?.next_action, "frg_pack");
});

test("unready candidate stops ship before leaf spawn and keeps train evidence (#1344)", async () => {
  const store = memoryShipStore();
  store.status = checkpoint({
    ship_key: shipKey(intent),
    next_action: "frg_pack",
    train,
    train_plan: { ordered_issues: [...train.ordered_issues] },
  });
  const spawned: string[][] = [];
  let prepareReturned = false;
  const bound = bindCandidateShipEndOperations(operations({
    observeFrg: async () => null,
  }), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: {},
    factoryReleaseRequestPath: "/abs/req.json",
    resolveCandidate: async () => {
      await Promise.resolve();
      prepareReturned = true;
      return {
        ok: false,
        kind: "readiness",
        error: "candidate engine at /cand is not ready: nested-core install failed. Run npm ci in /cand/core.",
      };
    },
    spawn: async (argv) => {
      spawned.push(argv);
      throw new Error("spawn must not run");
    },
  });
  const deps = shipCoordinatorDepsFromOperations(bound, { state: store });
  const wrapped = {
    ...deps,
    authorizationPublicKey: "test",
    withRunLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  };
  const status = await runShipCoordinator(intent, null, wrapped);
  assert.match(status.last_error ?? "", /readiness defect/);
  assert.equal(status.lifecycle, "cooling");
  assert.equal(prepareReturned, true);
  assert.equal(spawned.length, 0);
  assert.equal(store.status?.train?.integrated_head_oid, head);
  assert.equal(store.status?.frg_pack, null);
  assert.match(store.status?.last_error ?? "", /supervised lifecycle/);
  assert.doesNotMatch(store.status?.last_error ?? "", /needs-human|DecisionRequest|AuthorityRequest/);
  assert.equal(store.status?.human_authority, false);
  assert.equal(store.status?.next_action, "frg_pack");
});

test("no leaf spawn until resolve-and-prepare returns a ready root (#1344)", async () => {
  const spawned: string[][] = [];
  let ready = false;
  const bound = bindCandidateShipEndOperations(operations({
    observeRelease: async () => ({ prepare: release, finish: null }),
  }), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: { PIPELINE_FRG_ATTESTATION_KEY: "secret" },
    nodeBin: "/usr/bin/node",
    factoryReleaseRequestPath: "/abs/req.json",
    resolveCandidate: async () => {
      await Promise.resolve();
      ready = true;
      return { ok: true, engine: candidateEngine };
    },
    spawn: async (argv) => {
      assert.equal(ready, true, "leaf argv must not spawn before readiness success");
      spawned.push(argv);
      if (argv.includes("factory-release")) {
        return { code: 0, stdout: JSON.stringify({ status: "complete" }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await bound.runFrgPack!(intent, train);
  assert.equal(ready, true);
  assert.ok(spawned.some((argv) => argv.includes("factory-release")));
  assert.equal(
    spawned.findIndex((argv) => argv.includes("factory-release")) >= 0,
    true,
  );
});

test("realShipCoordinatorDeps points at resolve-and-prepare (#1344)", () => {
  const shipCode = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/stages/ship-adapter.ts"),
    "utf8",
  );
  assert.match(shipCode, /resolveAndPrepareCandidateEngine/);
  assert.match(shipCode, /defaultResolveAndPrepareDeps/);
  const resolveBlock = shipCode.slice(shipCode.indexOf("realShipCoordinatorDeps"));
  assert.match(resolveBlock, /resolveAndPrepareCandidateEngine\(/);
  assert.doesNotMatch(
    resolveBlock.slice(0, 2500),
    /resolveCandidateEngine\(\s*\{/,
  );
});

test("matching pin SHA keeps in-process pin prepare", async () => {
  let preparedInProcess = false;
  const spawned: string[][] = [];
  const bound = bindCandidateShipEndOperations(operations({
    prepareRelease: async () => {
      preparedInProcess = true;
      return release;
    },
  }), {
    pinCommitSha: head,
    repoDir: "/repo",
    env: {},
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await bound.prepareRelease(intent, head);
  assert.equal(preparedInProcess, true);
  assert.deepEqual(spawned, []);
});

test("in_progress prepare re-invokes prepare and does not factory-gate until eligible", async () => {
  const spawned: string[][] = [];
  let prepareTicks = 0;
  let gated = false;
  const bound = bindCandidateShipEndOperations(operations(), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: { PIPELINE_FRG_ATTESTATION_KEY: "secret" },
    factoryReleaseRequestPath: "/abs/req.json",
    frgWaitAttempts: 5,
    delay: async () => {},
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      if (argv.includes("factory-release")) {
        prepareTicks++;
        if (gated) {
          return { code: 0, stdout: JSON.stringify({ status: "complete" }), stderr: "" };
        }
        if (prepareTicks < 3) {
          return {
            code: 0,
            stdout: JSON.stringify({ status: "in_progress", loop_run_id: "loop-1" }),
            stderr: "",
          };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            status: "awaiting_frg_attestation",
            frg: { loop_run_id: "loop-1" },
          }),
          stderr: "",
        };
      }
      if (argv.includes("factory-gate")) gated = true;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await bound.runFrgPack!(intent, train);
  const prepares = spawned.filter((argv) => argv.includes("factory-release"));
  const gates = spawned.filter((argv) => argv.includes("factory-gate"));
  assert.equal(prepares.length, 4);
  assert.equal(gates.length, 1);
  assert.ok(gates[0]!.includes("loop-1"));
  assert.ok(
    spawned.findIndex((argv) => argv.includes("factory-gate")) >
      spawned.findIndex((argv) => argv.includes("factory-release")),
  );
  const gateIdx = spawned.findIndex((argv) => argv.includes("factory-gate"));
  assert.ok(
    spawned.slice(gateIdx + 1).some((argv) => argv.includes("factory-release")),
    "FRG pack must re-invoke prepare after factory-gate until complete",
  );
});

test("in_progress prepare within wait budget does not invoke factory-gate", async () => {
  const spawned: string[][] = [];
  const bound = bindCandidateShipEndOperations(operations(), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: {},
    factoryReleaseRequestPath: "/abs/req.json",
    frgWaitAttempts: 2,
    delay: async () => {},
    isBoundPackLoopLive: async () => false,
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      return {
        code: 0,
        stdout: JSON.stringify({ status: "in_progress", loop_run_id: "loop-1" }),
        stderr: "",
      };
    },
  });
  await assert.rejects(
    bound.runFrgPack!(intent, train),
    /did not reach complete/,
  );
  assert.equal(spawned.filter((argv) => argv.includes("factory-release")).length, 2);
  assert.equal(spawned.filter((argv) => argv.includes("factory-gate")).length, 0);
});

test("classifyFrgPackWaitDecision: live in_progress at cap is continue (#1150)", () => {
  assert.equal(
    classifyFrgPackWaitDecision({ tick: "retry", live: true, attempt: 2, cap: 2 }),
    "continue",
  );
  assert.equal(
    classifyFrgPackWaitDecision({ tick: "retry", live: "unknown", attempt: 2, cap: 2 }),
    "continue",
  );
  assert.equal(
    classifyFrgPackWaitDecision({ tick: "retry", live: false, attempt: 2, cap: 2 }),
    "fail",
  );
  assert.equal(
    classifyFrgPackWaitDecision({ tick: "retry", live: false, attempt: 1, cap: 2 }),
    "continue",
  );
  assert.equal(
    classifyFrgPackWaitDecision({ tick: "attest", live: false, attempt: 1, cap: 2 }),
    "continue",
  );
  assert.equal(
    classifyFrgPackWaitDecision({
      tick: "attest",
      live: false,
      attempt: 1,
      cap: 2,
      attestAllowanceSpent: true,
    }),
    "fail",
    "spent attest allowance must not continue",
  );
  assert.equal(boundPackLoopIsLive({
    lockPidAlive: true,
    ledgerPresent: false,
    ledgerStopPresent: false,
    eventsTerminal: false,
    handoffPresent: true,
    heartbeatFresh: true,
    pidMatches: true,
  }), true);
  assert.equal(boundPackLoopIsLive({
    lockPidAlive: false,
    ledgerPresent: true,
    ledgerStopPresent: false,
    eventsTerminal: false,
  }), false, "dead pid plus open ledger is not live");
  assert.equal(boundPackLoopIsLive({
    lockPidAlive: false,
    ledgerPresent: false,
    ledgerStopPresent: false,
    eventsTerminal: false,
  }), false);
  assert.equal(boundPackLoopIsLive({
    lockPidAlive: false,
    ledgerPresent: true,
    ledgerStopPresent: true,
    eventsTerminal: false,
  }), false);
  assert.equal(classifyBoundPackLoopLiveness({
    lockPidAlive: false,
    lockUnreadable: true,
    ledgerPresent: false,
    ledgerStopPresent: false,
    eventsTerminal: false,
  }), "unknown");
  assert.equal(classifyBoundPackLoopLiveness({
    lockPidAlive: false,
    ledgerPresent: false,
    ledgerStopPresent: false,
    ledgerUnreadable: true,
    eventsTerminal: false,
  }), "unknown");
  assert.equal(classifyBoundPackLoopLiveness({
    lockPidAlive: false,
    lockUnreadable: true,
    ledgerPresent: true,
    ledgerStopPresent: false,
    eventsTerminal: false,
  }), "unknown");
  assert.equal(
    classifyFrgPackWaitDecision({ tick: "retry", live: "failed", attempt: 2, cap: 2 }),
    "fail",
  );
});

test("live in_progress at cap keeps re-invoking prepare (#1150)", async () => {
  const spawned: string[][] = [];
  const heartbeats: Array<{ attempt: number; live: string }> = [];
  let prepareTicks = 0;
  const bound = bindCandidateShipEndOperations(operations(), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: {},
    factoryReleaseRequestPath: "/abs/req.json",
    frgWaitAttempts: 2,
    delay: async () => {},
    isBoundPackLoopLive: async () => true,
    onFrgWaitTick: (tick) => {
      heartbeats.push({ attempt: tick.attempt, live: tick.live });
    },
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      prepareTicks++;
      if (prepareTicks < 3) {
        return {
          code: 0,
          stdout: JSON.stringify({ status: "in_progress", loop_run_id: "loop-1" }),
          stderr: "",
        };
      }
      return { code: 0, stdout: JSON.stringify({ status: "complete" }), stderr: "" };
    },
  });
  await bound.runFrgPack!(intent, train);
  assert.equal(spawned.filter((argv) => argv.includes("factory-release")).length, 3);
  assert.equal(spawned.filter((argv) => argv.includes("factory-gate")).length, 0);
  assert.deepEqual(heartbeats, [
    { attempt: 1, live: "live" },
    { attempt: 2, live: "live" },
  ]);
});

test("unknown liveness at cap keeps re-invoking prepare (#1150)", async () => {
  const spawned: string[][] = [];
  const heartbeats: Array<{ attempt: number; live: string }> = [];
  let prepareTicks = 0;
  const bound = bindCandidateShipEndOperations(operations(), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: {},
    factoryReleaseRequestPath: "/abs/req.json",
    frgWaitAttempts: 2,
    delay: async () => {},
    isBoundPackLoopLive: async () => "unknown",
    onFrgWaitTick: (tick) => {
      heartbeats.push({ attempt: tick.attempt, live: tick.live });
    },
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      prepareTicks++;
      if (prepareTicks < 3) {
        return {
          code: 0,
          stdout: JSON.stringify({ status: "in_progress", loop_run_id: "loop-1" }),
          stderr: "",
        };
      }
      return { code: 0, stdout: JSON.stringify({ status: "complete" }), stderr: "" };
    },
  });
  await bound.runFrgPack!(intent, train);
  assert.equal(spawned.filter((argv) => argv.includes("factory-release")).length, 3);
  assert.deepEqual(heartbeats, [
    { attempt: 1, live: "unknown" },
    { attempt: 2, live: "unknown" },
  ]);
});

test("dead-loop in_progress at cap still throws resume-to-retry (#1150)", async () => {
  const spawned: string[][] = [];
  const bound = bindCandidateShipEndOperations(operations(), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: {},
    factoryReleaseRequestPath: "/abs/req.json",
    frgWaitAttempts: 2,
    delay: async () => {},
    isBoundPackLoopLive: async () => false,
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      return {
        code: 0,
        stdout: JSON.stringify({ status: "in_progress", loop_run_id: "loop-1" }),
        stderr: "",
      };
    },
  });
  await assert.rejects(
    bound.runFrgPack!(intent, train),
    /retry the same ship command to resume the bound pack/,
  );
  assert.equal(spawned.filter((argv) => argv.includes("factory-release")).length, 2);
});

const TERMINAL_LEDGER_STOP = {
  reason: "supervisor_cycle_cap",
  time: "2026-08-20T00:00:00.000Z",
} as const;

function durableLedgerJson(runId: string, stop: unknown): string {
  return JSON.stringify({ schema: LOOP_LEDGER_SCHEMA, run_id: runId, stop });
}

function liveHandoffJson(runId: string, sha = "a".repeat(40)): string {
  return JSON.stringify({
    schema_version: "1",
    kind: "loop_run_handoff",
    run_id: runId,
    run_dir: `/home/runs/${runId}`,
    events: `/home/runs/${runId}/events.jsonl`,
    engine: "claude",
    resumed: false,
    selector: null,
    candidate_sha: sha,
    supervisor: {
      pid: 42,
      boot_id: "boot-1",
      started_at: "2026-08-29T11:59:00.000Z",
      token: "tok",
    },
  });
}

function liveSupervisorJson(runId: string): string {
  return JSON.stringify({
    run_id: runId,
    engine: "claude",
    pid: 42,
    hostname: "host",
    boot_id: "boot-1",
    started_at: "2026-08-29T11:59:00.000Z",
    heartbeat_at: new Date().toISOString(),
    token: "tok",
    consecutive_no_progress: 0,
  });
}

test("probeBoundPackLoopLive requires handoff identity, not an open ledger (#1296)", async () => {
  const files = new Map<string, string>([
    ["/home/runs/loop-live/ledger.json", durableLedgerJson("loop-live", null)],
    ["/home/runs/loop-dead/lock.json", JSON.stringify({ pid: 99 })],
    [
      "/home/runs/loop-dead/ledger.json",
      durableLedgerJson("loop-dead", TERMINAL_LEDGER_STOP),
    ],
    ["/home/runs/loop-pid/lock.json", JSON.stringify({ pid: 42 })],
    ["/home/runs/loop-acked/lock.json", JSON.stringify({ pid: 42 })],
    ["/home/runs/loop-acked/loop-run-handoff.json", liveHandoffJson("loop-acked")],
    ["/home/runs/loop-acked/supervisor.json", liveSupervisorJson("loop-acked")],
  ]);
  const env = { AGENT_PIPELINE_STATE_HOME: "/home" } as NodeJS.ProcessEnv;
  const readTextFile = (p: string) => files.get(p) ?? null;
  assert.equal(
    await probeBoundPackLoopLive("loop-live", { env, readTextFile, isPidAlive: () => false }),
    "not-live",
    "dead pid plus open ledger is not live",
  );
  assert.equal(
    await probeBoundPackLoopLive("loop-dead", { env, readTextFile, isPidAlive: () => false }),
    "not-live",
  );
  assert.equal(
    await probeBoundPackLoopLive("loop-pid", { env, readTextFile, isPidAlive: (pid) => pid === 42 }),
    "not-live",
    "alive pid without handoff is not live",
  );
  assert.equal(
    await probeBoundPackLoopLive("loop-missing", { env, readTextFile, isPidAlive: () => false }),
    "not-live",
  );
  assert.equal(
    await probeBoundPackLoopLive("loop-acked", {
      env,
      readTextFile,
      isPidAlive: (pid) => pid === 42,
      now: () => new Date(),
    }),
    "live",
  );
});

test("probeBoundPackLoopLive treats read failures and corrupt state as unknown (#1150)", async () => {
  const env = { AGENT_PIPELINE_STATE_HOME: "/home" } as NodeJS.ProcessEnv;
  const eacces = (): never => {
    const err = new Error("EACCES") as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  };
  assert.equal(
    await probeBoundPackLoopLive("loop-eacces", {
      env,
      isPidAlive: () => false,
      readTextFile: (p) => (p.endsWith("lock.json") ? eacces() : null),
    }),
    "unknown",
  );
  assert.equal(
    await probeBoundPackLoopLive("loop-eio-ledger", {
      env,
      isPidAlive: () => false,
      readTextFile: (p) => {
        if (p.endsWith("lock.json")) return JSON.stringify({ pid: 99 });
        if (p.endsWith("ledger.json")) {
          const err = new Error("EIO") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
        return null;
      },
    }),
    "not-live",
  );
  assert.equal(
    await probeBoundPackLoopLive("loop-corrupt", {
      env,
      isPidAlive: () => false,
      readTextFile: (p) => (p.endsWith("lock.json") ? "{" : null),
    }),
    "unknown",
  );
  assert.equal(
    await probeBoundPackLoopLive("loop-corrupt-ledger", {
      env,
      isPidAlive: () => false,
      readTextFile: (p) => {
        if (p.endsWith("lock.json")) return JSON.stringify({ pid: 99 });
        if (p.endsWith("ledger.json")) return "{";
        return null;
      },
    }),
    "not-live",
  );
  assert.equal(
    await probeBoundPackLoopLive("loop-unreadable-lock-live-ledger", {
      env,
      isPidAlive: () => false,
      readTextFile: (p) => {
        if (p.endsWith("lock.json")) return eacces();
        if (p.endsWith("ledger.json")) {
          return durableLedgerJson("loop-unreadable-lock-live-ledger", null);
        }
        return null;
      },
    }),
    "unknown",
  );
});

test("probeBoundPackLoopLive treats schema-invalid or blank state as unknown at cap (#1150)", async () => {
  const env = { AGENT_PIPELINE_STATE_HOME: "/home" } as NodeJS.ProcessEnv;
  const files = new Map<string, string>([
    ["/home/runs/loop-empty-lock/lock.json", "{}"],
    ["/home/runs/loop-bad-pid/lock.json", JSON.stringify({ pid: "bad" })],
    ["/home/runs/loop-blank-ledger/ledger.json", "  \n\t"],
    [
      "/home/runs/loop-bad-stop/lock.json",
      JSON.stringify({ pid: 99 }),
    ],
    [
      "/home/runs/loop-bad-stop/ledger.json",
      durableLedgerJson("loop-bad-stop", true),
    ],
    [
      "/home/runs/loop-bad-stop-str/lock.json",
      JSON.stringify({ pid: 99 }),
    ],
    [
      "/home/runs/loop-bad-stop-str/ledger.json",
      durableLedgerJson("loop-bad-stop-str", "yes"),
    ],
    [
      "/home/runs/loop-empty-stop/lock.json",
      JSON.stringify({ pid: 99 }),
    ],
    [
      "/home/runs/loop-empty-stop/ledger.json",
      durableLedgerJson("loop-empty-stop", {}),
    ],
    [
      "/home/runs/loop-malformed-stop/lock.json",
      JSON.stringify({ pid: 99 }),
    ],
    [
      "/home/runs/loop-malformed-stop/ledger.json",
      durableLedgerJson("loop-malformed-stop", {
        reason: "not-a-terminal-reason",
        time: "2026-08-20T00:00:00.000Z",
      }),
    ],
  ]);
  const readTextFile = (p: string) => files.get(p) ?? null;
  const opts = { env, readTextFile, isPidAlive: () => false };
  for (const id of ["loop-empty-lock", "loop-bad-pid"]) {
    const live = await probeBoundPackLoopLive(id, opts);
    assert.equal(live, "unknown", `${id} must be unknown`);
    assert.equal(
      classifyFrgPackWaitDecision({ tick: "retry", live, attempt: 2, cap: 2 }),
      "continue",
    );
  }
  for (const id of [
    "loop-blank-ledger",
    "loop-bad-stop",
    "loop-bad-stop-str",
    "loop-empty-stop",
    "loop-malformed-stop",
  ]) {
    const live = await probeBoundPackLoopLive(id, opts);
    assert.equal(live, "not-live", `${id} has no handoff and is not live`);
  }
});

test("probeBoundPackLoopLive treats missing or mismatched ledger identity as unknown at cap (#1150)", async () => {
  const env = { AGENT_PIPELINE_STATE_HOME: "/home" } as NodeJS.ProcessEnv;
  const files = new Map<string, string>([
    ["/home/runs/loop-stop-only/lock.json", JSON.stringify({ pid: 99 })],
    [
      "/home/runs/loop-stop-only/ledger.json",
      JSON.stringify({ stop: TERMINAL_LEDGER_STOP }),
    ],
    ["/home/runs/loop-missing-schema/lock.json", JSON.stringify({ pid: 99 })],
    [
      "/home/runs/loop-missing-schema/ledger.json",
      JSON.stringify({ run_id: "loop-missing-schema", stop: TERMINAL_LEDGER_STOP }),
    ],
    ["/home/runs/loop-numeric-schema/lock.json", JSON.stringify({ pid: 99 })],
    [
      "/home/runs/loop-numeric-schema/ledger.json",
      JSON.stringify({
        schema: 1,
        run_id: "loop-numeric-schema",
        stop: TERMINAL_LEDGER_STOP,
      }),
    ],
    ["/home/runs/loop-mismatched-id/lock.json", JSON.stringify({ pid: 99 })],
    [
      "/home/runs/loop-mismatched-id/ledger.json",
      durableLedgerJson("other-loop", TERMINAL_LEDGER_STOP),
    ],
  ]);
  const readTextFile = (p: string) => files.get(p) ?? null;
  const opts = { env, readTextFile, isPidAlive: () => false };
  for (const id of [
    "loop-stop-only",
    "loop-missing-schema",
    "loop-numeric-schema",
    "loop-mismatched-id",
  ]) {
    const live = await probeBoundPackLoopLive(id, opts);
    assert.equal(live, "not-live", `${id} has no handoff and is not live`);
  }
});

test("empty or malformed ledger stop at cap keeps re-invoking prepare (#1150)", async () => {
  const spawned: string[][] = [];
  const heartbeats: Array<{ attempt: number; live: string }> = [];
  let prepareTicks = 0;
  const bound = bindCandidateShipEndOperations(operations(), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: {},
    factoryReleaseRequestPath: "/abs/req.json",
    frgWaitAttempts: 2,
    delay: async () => {},
    onFrgWaitTick: (tick) => {
      heartbeats.push({ attempt: tick.attempt, live: tick.live });
    },
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      prepareTicks++;
      if (prepareTicks < 3) {
        return {
          code: 0,
          stdout: JSON.stringify({
            status: "in_progress",
            loop_run_id: "loop-1",
            liveness: {
              schema_version: 1,
              kind: "pack_loop_liveness",
              loop_run_id: "loop-1",
              status: "unknown",
              reason: "unreadable_identity",
              observed_at: "2026-08-29T12:00:00.000Z",
            },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: JSON.stringify({ status: "complete" }), stderr: "" };
    },
  });
  await bound.runFrgPack!(intent, train);
  assert.equal(spawned.filter((argv) => argv.includes("factory-release")).length, 3);
  assert.deepEqual(heartbeats, [
    { attempt: 1, live: "unknown" },
    { attempt: 2, live: "unknown" },
  ]);
});

test("missing or mismatched ledger identity at cap keeps re-invoking prepare (#1150)", async () => {
  const spawned: string[][] = [];
  const heartbeats: Array<{ attempt: number; live: string }> = [];
  let prepareTicks = 0;
  const bound = bindCandidateShipEndOperations(operations(), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: {},
    factoryReleaseRequestPath: "/abs/req.json",
    frgWaitAttempts: 2,
    delay: async () => {},
    onFrgWaitTick: (tick) => {
      heartbeats.push({ attempt: tick.attempt, live: tick.live });
    },
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      prepareTicks++;
      if (prepareTicks < 3) {
        return {
          code: 0,
          stdout: JSON.stringify({
            status: "in_progress",
            loop_run_id: "loop-1",
            liveness: {
              schema_version: 1,
              kind: "pack_loop_liveness",
              loop_run_id: "loop-1",
              status: "unknown",
              reason: "unreadable_identity",
              observed_at: "2026-08-29T12:00:00.000Z",
            },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: JSON.stringify({ status: "complete" }), stderr: "" };
    },
  });
  await bound.runFrgPack!(intent, train);
  assert.equal(spawned.filter((argv) => argv.includes("factory-release")).length, 3);
  assert.deepEqual(heartbeats, [
    { attempt: 1, live: "unknown" },
    { attempt: 2, live: "unknown" },
  ]);
});

test("missing request path fails closed before candidate FRG prepare", async () => {
  const spawned: string[][] = [];
  const bound = bindCandidateShipEndOperations(operations({
    observeFrg: async () => {
      throw new Error("observeFrg must not run from runFrgPack");
    },
  }), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: {},
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(
    bound.runFrgPack!(intent, train),
    /missing factory-release prepare request path/,
  );
  assert.deepEqual(spawned, []);
});

function shipUnsignedPayload(over: Partial<FactoryReleaseFrgPayload> = {}): FactoryReleaseFrgPayload {
  const art = (n: number) => ({ path: `/tmp/art-${n}.json`, sha256: String(n).repeat(64).slice(0, 64) });
  return {
    pack_id: "factory-gate-v1",
    manifest_path: "/pack/manifest.json",
    manifest_sha256: "a".repeat(64),
    pack_run_id: "pack-1",
    loop_run_id: "loop-1",
    frg_run_id: "frg-A",
    evidence_created_at: "2026-08-29T00:00:00Z",
    observations: art(1),
    evidence_bundle: art(2),
    contract: art(3),
    ledger: art(4),
    events: art(5),
    action_evidence: art(6),
    ...over,
  };
}

function shipPrepareRequest(): FactoryReleasePrepareRequest {
  return {
    schema_version: 1,
    kind: "factory_release_prepare_request",
    action_id: "action-ship-1.34.0",
    repository: intent.repository,
    base_branch: intent.base_branch,
    target_version: intent.version,
    integrated_candidate: { git_sha: head, version: "1.33.0" },
    production_pin: { version: "1.33.0", tag: "v1.33.0", git_sha: PIN_SHA },
    frg_manifest: { pack_id: "factory-gate-v1", sha256: "a".repeat(64) },
  };
}

async function shipHybridFromRunEvidence(opts: {
  unsigned: FactoryReleaseFrgPayload;
  request: FactoryReleasePrepareRequest;
  runId: string;
  includeBinding: boolean;
}): Promise<FrgEvidence> {
  const pack = await loadFrgPack();
  const issueNumbers = [1112, 1113];
  const rendered = renderFrgPackIssues(pack, {
    release_version: opts.request.target_version,
    pack_run_id: opts.unsigned.pack_run_id,
  });
  const collected = collectFrgPackObservations(pack, {
    schema_version: 1,
    policy_id: pack.manifest.pilot_policy.id,
    pack_id: pack.manifest.pack_id,
    manifest_version: pack.manifest.manifest_version,
    manifest_sha256: pack.manifest_sha256,
    release_version: opts.request.target_version,
    candidate_git_sha: opts.request.integrated_candidate.git_sha,
    pack_run_id: opts.unsigned.pack_run_id,
    loop_run_id: opts.unsigned.loop_run_id,
    repository: opts.request.repository,
    base_branch: opts.request.base_branch,
    started_at: "2026-08-18T02:54:58.000Z",
    contract: {
      artifact_sha256: "b".repeat(64),
      selector: { type: "label", value: "factory-gate" },
      issue_numbers: issueNumbers,
      items: issueNumbers.map((n) => ({ issue_number: n, depends_on: [] })),
    },
    ledger: {
      artifact_sha256: "c".repeat(64),
      items: issueNumbers.map((n) => ({
        issue_number: n,
        state: "ready",
        advance_run_id: `adv-${n}`,
        blocked_theme: null,
      })),
    },
    events: {
      artifact_sha256: "d".repeat(64),
      event_ids: issueNumbers.map((n) => `event:1:item-${n}`),
      issue_numbers: issueNumbers,
    },
    action_evidence: {
      artifact_sha256: "e".repeat(64),
      action_ids: issueNumbers.map((n) => `action:1:item-${n}`),
      issue_numbers: issueNumbers,
    },
    issues: rendered.map((issue, index) => {
      const issueNumber = issueNumbers[index]!;
      const prHead = String(index + 1).repeat(40);
      const files =
        issue.provenance.template_id === "clean-openspec"
          ? ["openspec/changes/archive/2026-08-18-x/proposal.md", "openspec/specs/frg/spec.md"]
          : ["docs/frg-fixture.md"];
      return {
        issue_number: issueNumber,
        issue_node_id: `ISSUE_${issueNumber}`,
        created_at: `2026-08-18T02:55:0${index}.000Z`,
        title: issue.title,
        body: issue.body,
        labels: [...issue.labels, "pipeline:ready-to-deploy"],
        template_id: issue.provenance.template_id,
        template_sha256: issue.provenance.template_sha256,
        pr: {
          number: 2100 + index,
          node_id: `PR_${2100 + index}`,
          head_sha: prHead,
          base_branch: "main",
          files,
          checks: [{ id: `CHECK_${issueNumber}`, name: "ci", head_sha: prHead, conclusion: "success" }],
        },
      };
    }),
    probes: pack.manifest.pilot_policy.layer_a_probes.map((probe, index) => ({
      id: probe.id,
      candidate_git_sha: opts.request.integrated_candidate.git_sha,
      test_file: probe.test_file,
      test_name: probe.test_name,
      command_argv_sha256: "1".repeat(64),
      stdout_sha256: "2".repeat(64),
      stderr_sha256: "3".repeat(64),
      started_at: `2026-08-18T03:00:${String(index).padStart(2, "0")}.000Z`,
      finished_at: `2026-08-18T03:00:${String(index).padStart(2, "0")}.500Z`,
    })),
  });
  const binding = buildFactoryReleaseUnsignedDigestBinding(opts.request, opts.unsigned);
  return computeFrgEvidence({
    version: opts.request.target_version,
    run_id: opts.runId,
    loop_run_id: opts.unsigned.loop_run_id,
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: issueNumbers.map((n) => ({ item_id: String(n), state: "ready" as const, ready_clean: true })),
    scenario_overrides: collected.scenarios.map((s) => ({
      id: s.id as never,
      status: s.status,
      detail: s.detail,
      observed: s.observed,
      threshold: s.threshold,
      source: s.source,
      proof_ids: s.proof_ids,
    })),
    composition_overrides: collected.composition.map((d) => ({
      id: d.id as never,
      status: d.status,
      detail: d.detail,
      source: d.source,
      observed: d.observed,
      proof_ids: d.proof_ids,
    })),
    false_human_authority_count: collected.false_human_authority_count,
    pack_provenance: collected.pack_provenance,
    factory_release_binding: opts.includeBinding ? binding : undefined,
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
    score_source: "from-run",
    ...frgPassUniqueOperations(opts.request.target_version),
    work_list: "factory-gate-pack",
  });
}

test("candidate FRG pack re-invokes the same prepare request after factory-gate until complete", async () => {
  const spawned: string[][] = [];
  const requestPath = "/abs/req.json";
  const request = shipPrepareRequest();
  const unsigned = shipUnsignedPayload();
  const binding = buildFactoryReleaseUnsignedDigestBinding(request, unsigned);
  const runIdB = computeAttestorRunId(binding);
  const files = new Map<string, string>();
  const latestPath = `/repo/.agent-pipeline/frg/${request.target_version}/latest.json`;
  const bound = bindCandidateShipEndOperations(operations(), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: { PIPELINE_FRG_ATTESTATION_KEY: "secret" },
    factoryReleaseRequestPath: requestPath,
    frgWaitAttempts: 4,
    delay: async () => {},
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      if (argv.includes("factory-release")) {
        assert.ok(argv.includes(requestPath), "prepare must keep the bound request path");
        const observed = await defaultObserveAttestation(
          request,
          unsigned,
          { repoDir: "/repo", workDir: "/tmp/work" },
          async (p) => {
            const v = files.get(p);
            if (v === undefined) {
              const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
              err.code = "ENOENT";
              throw err;
            }
            return v;
          },
          async (p) => files.has(p),
          { attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY },
        );
        if (observed.status === "accepted") {
          return { code: 0, stdout: JSON.stringify({ status: "complete" }), stderr: "" };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            status: "awaiting_frg_attestation",
            frg: { loop_run_id: unsigned.loop_run_id, frg_run_id: unsigned.frg_run_id },
            observe_miss:
              observed.status === "rejected"
                ? {
                    reason: observed.reason,
                    expected_frg_run_id: observed.expected_frg_run_id,
                    observed_run_id: observed.observed_run_id,
                  }
                : undefined,
          }),
          stderr: "",
        };
      }
      if (argv.includes("factory-gate")) {
        const evidence = await shipHybridFromRunEvidence({
          unsigned,
          request,
          runId: runIdB,
          includeBinding: true,
        });
        files.set(latestPath, JSON.stringify(evidence));
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected spawn ${argv.join(" ")}`);
    },
  });
  await bound.runFrgPack!(intent, train);
  const verbs = spawned.map((argv) =>
    argv.includes("factory-gate") ? "gate" : argv.includes("factory-release") ? "prepare" : "other",
  );
  assert.deepEqual(verbs, ["prepare", "gate", "prepare"]);
  assert.equal(spawned.filter((argv) => argv.includes(requestPath)).length, 2);
  assert.ok(files.has(latestPath), "factory-gate must persist a real-shaped --from-run payload");
});

test("runFrgPack fails closed after one attest when observe stays rejected (#1295)", async () => {
  const spawned: string[][] = [];
  const requestPath = "/abs/req.json";
  const unsigned = shipUnsignedPayload();
  const bound = bindCandidateShipEndOperations(operations(), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: { PIPELINE_FRG_ATTESTATION_KEY: "secret" },
    factoryReleaseRequestPath: requestPath,
    frgWaitAttempts: 8,
    delay: async () => {},
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      if (argv.includes("factory-release")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            status: "awaiting_frg_attestation",
            frg: { loop_run_id: unsigned.loop_run_id, frg_run_id: unsigned.frg_run_id },
            observe_miss: {
              reason: "missing_factory_release_binding",
              expected_frg_run_id: unsigned.frg_run_id,
              observed_run_id: "frg-B",
            },
          }),
          stderr: "",
        };
      }
      if (argv.includes("factory-gate")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected spawn ${argv.join(" ")}`);
    },
  });
  const hung = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("runFrgPack did not terminate")), 2000);
  });
  await assert.rejects(
    Promise.race([bound.runFrgPack!(intent, train), hung]),
    /unsigned_frg_run_id=frg-A[\s\S]*observed_run_id=frg-B[\s\S]*missing_factory_release_binding/,
  );
  assert.equal(spawned.filter((argv) => argv.includes("factory-gate")).length, 1);
  assert.equal(spawned.filter((argv) => argv.includes("factory-release")).length, 2);
});

test("changed unsigned checkpoint resets the attest allowance (#1295)", async () => {
  const spawned: string[][] = [];
  let prepareTicks = 0;
  const bound = bindCandidateShipEndOperations(operations(), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: { PIPELINE_FRG_ATTESTATION_KEY: "secret" },
    factoryReleaseRequestPath: "/abs/req.json",
    frgWaitAttempts: 4,
    delay: async () => {},
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      if (argv.includes("factory-release")) {
        prepareTicks += 1;
        if (prepareTicks === 1) {
          return {
            code: 0,
            stdout: JSON.stringify({
              status: "awaiting_frg_attestation",
              frg: { loop_run_id: "loop-1", frg_run_id: "frg-A" },
            }),
            stderr: "",
          };
        }
        if (prepareTicks === 2) {
          return {
            code: 0,
            stdout: JSON.stringify({
              status: "awaiting_frg_attestation",
              frg: { loop_run_id: "loop-1", frg_run_id: "frg-A-prime" },
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: JSON.stringify({ status: "complete" }), stderr: "" };
      }
      if (argv.includes("factory-gate")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected spawn ${argv.join(" ")}`);
    },
  });
  await bound.runFrgPack!(intent, train);
  assert.equal(spawned.filter((argv) => argv.includes("factory-gate")).length, 2);
  assert.equal(spawned.filter((argv) => argv.includes("factory-release")).length, 3);
});

test("injected request resolver supplies the persisted prepare path when option is omitted", async () => {
  const spawned: string[][] = [];
  const bound = bindCandidateShipEndOperations(operations(), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: {},
    resolveFactoryReleaseRequestPath: async () => "/state/ships/ship-key/factory-release-prepare-request.json",
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      if (argv.includes("factory-release")) {
        return {
          code: 0,
          stdout: JSON.stringify({ status: "complete" }),
          stderr: "",
        };
      }
      throw new Error(`unexpected spawn ${argv.join(" ")}`);
    },
  });
  await bound.runFrgPack!(intent, train);
  assert.ok(spawned.some((argv) => argv.includes("/state/ships/ship-key/factory-release-prepare-request.json")));
  assert.equal(spawned.filter((argv) => argv.includes("factory-gate")).length, 0);
});

test("default candidate tag path spawns release ensure-tag on the candidate launcher", async () => {
  const spawned: string[][] = [];
  let taggedInProcess = false;
  const bound = bindCandidateShipEndOperations(operations({
    observePublication: async () => publication,
    waitForPublication: async () => {
      taggedInProcess = true;
      return publication;
    },
  }), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: { PIPELINE_FRG_ATTESTATION_KEY: "secret" },
    nodeBin: "/usr/bin/node",
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const result = await bound.waitForPublication(intent, releaseFinish);
  assert.deepEqual(result, publication);
  assert.equal(taggedInProcess, false);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0], [
    "/usr/bin/node",
    "/cand/scripts/pipeline-launcher.mjs",
    "release",
    "ensure-tag",
    intent.version,
    mergeHead,
    "--packed-candidate",
    head,
  ]);
});

test("candidate ensure-tag leaf fails closed on non-zero spawn without pin-process tag", async () => {
  let observed = 0;
  let taggedInProcess = false;
  const bound = bindCandidateShipEndOperations(operations({
    observePublication: async () => {
      observed++;
      return publication;
    },
    waitForPublication: async () => {
      taggedInProcess = true;
      return publication;
    },
  }), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: { PIPELINE_FRG_ATTESTATION_KEY: "secret" },
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async () => ({ code: 1, stdout: "", stderr: "candidate tag refused" }),
  });
  await assert.rejects(
    bound.waitForPublication(intent, releaseFinish),
    /candidate ensure-tag failed/,
  );
  assert.equal(observed, 0);
  assert.equal(taggedInProcess, false);
});

test("in-engine HMAC children present KEY_FILE as KEY and prepare stays uncredentialed (#1181)", async () => {
  const dummy = "dummy-key";
  const keyFile = "/keys/frg-dummy";
  const parent: NodeJS.ProcessEnv = { PIPELINE_FRG_ATTESTATION_KEY_FILE: keyFile };
  delete parent.PIPELINE_FRG_ATTESTATION_KEY;
  const recorded: Array<{ verb: string; env: NodeJS.ProcessEnv }> = [];
  let gated = false;
  const bound = bindCandidateShipEndOperations(operations({
    observePublication: async () => publication,
  }), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: parent,
    presentAttestorCredential: {
      readFile(p) {
        if (p !== keyFile) throw new Error(`unexpected KEY_FILE ${p}`);
        return Buffer.from(dummy);
      },
    },
    factoryReleaseRequestPath: "/abs/req.json",
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv, env) => {
      const verb = argv.includes("factory-gate")
        ? "attestor"
        : argv.includes("ensure-tag")
          ? "ensure-tag"
          : argv.includes("factory-release")
            ? "prepare"
            : "other";
      recorded.push({ verb, env: { ...env } });
      if (verb === "prepare") {
        if (gated) {
          return { code: 0, stdout: JSON.stringify({ status: "complete" }), stderr: "" };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            status: "awaiting_frg_attestation",
            frg: { loop_run_id: "loop-1" },
          }),
          stderr: "",
        };
      }
      if (verb === "attestor") gated = true;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await bound.runFrgPack!(intent, train);
  await bound.waitForPublication(intent, releaseFinish);
  const attestor = recorded.find((r) => r.verb === "attestor");
  const tag = recorded.find((r) => r.verb === "ensure-tag");
  const prepare = recorded.find((r) => r.verb === "prepare");
  assert.ok(attestor, "attestor child must spawn");
  assert.ok(tag, "ensure-tag child must spawn");
  assert.ok(prepare, "prepare child must spawn");
  for (const child of [attestor, tag]) {
    const hasKey = typeof child!.env.PIPELINE_FRG_ATTESTATION_KEY === "string"
      && child!.env.PIPELINE_FRG_ATTESTATION_KEY !== "";
    const hasKeyFile = typeof child!.env.PIPELINE_FRG_ATTESTATION_KEY_FILE === "string"
      && child!.env.PIPELINE_FRG_ATTESTATION_KEY_FILE !== "";
    assert.ok(
      hasKey || hasKeyFile,
      `${child!.verb} must present KEY or KEY_FILE when parent supplied a readable non-empty KEY_FILE`,
    );
    assert.equal(child!.env.PIPELINE_FRG_ATTESTATION_KEY, dummy);
    assert.equal(child!.env.PIPELINE_FRG_ATTESTATION_KEY_FILE, undefined);
  }
  assert.equal(prepare.env.PIPELINE_FRG_ATTESTATION_KEY, undefined);
  assert.equal(prepare.env.PIPELINE_FRG_ATTESTATION_KEY_FILE, undefined);
  assert.equal(parent.PIPELINE_FRG_ATTESTATION_KEY, undefined);
  assert.equal(parent.PIPELINE_FRG_ATTESTATION_KEY_FILE, keyFile);
});

test("in-engine HMAC-verify does not spawn without a credential (#1181)", async () => {
  const spawned: string[][] = [];
  const bound = bindCandidateShipEndOperations(operations({
    observePublication: async () => publication,
  }), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: {},
    factoryReleaseRequestPath: "/abs/req.json",
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      if (argv.includes("factory-release")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            status: "awaiting_frg_attestation",
            frg: { loop_run_id: "loop-1" },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(bound.runFrgPack!(intent, train), /missing_attestor_credential/);
  assert.equal(spawned.filter((argv) => argv.includes("factory-gate")).length, 0);
  await assert.rejects(
    bound.waitForPublication(intent, releaseFinish),
    /missing_attestor_credential/,
  );
  assert.equal(spawned.filter((argv) => argv.includes("ensure-tag")).length, 0);
});

test("in-engine HMAC-verify does not spawn on unreadable KEY_FILE (#1181)", async () => {
  const spawned: string[][] = [];
  const bound = bindCandidateShipEndOperations(operations({
    observePublication: async () => publication,
  }), {
    pinCommitSha: PIN_SHA,
    repoDir: "/repo",
    env: { PIPELINE_FRG_ATTESTATION_KEY_FILE: "/keys/missing" },
    presentAttestorCredential: {
      readFile() {
        throw new Error("EACCES");
      },
    },
    factoryReleaseRequestPath: "/abs/req.json",
    resolveCandidate: async () => ({ ok: true, engine: candidateEngine }),
    spawn: async (argv) => {
      spawned.push(argv);
      if (argv.includes("factory-release")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            status: "awaiting_frg_attestation",
            frg: { loop_run_id: "loop-1" },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(bound.runFrgPack!(intent, train), /unreadable_attestor_key_file/);
  assert.equal(spawned.filter((argv) => argv.includes("factory-gate")).length, 0);
});

test("candidate ensure-tag spawn does not use uncredentialedPrepareEnv (#1181)", () => {
  const shipAdapter = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "stages", "ship-adapter.ts"),
    "utf8",
  );
  const waitFn = shipAdapter.slice(
    shipAdapter.lastIndexOf("async waitForPublication"),
    shipAdapter.indexOf("function defaultResolveCandidateDeps"),
  );
  assert.match(waitFn, /hmacVerifyChildEnv/);
  assert.doesNotMatch(waitFn, /uncredentialedPrepareEnv/);
});

test("runEnsureAnnotatedReleaseTagCli tags via injected git, not ambient git", async () => {
  const gitCalls: string[][] = [];
  const result = await runEnsureAnnotatedReleaseTagCli(
    {
      repoDir: "/repo",
      version: intent.version,
      mergeCommitOid: mergeHead,
      packedCandidate: head,
    },
    {
      git: async (args) => {
        gitCalls.push(args);
        if (args[0] === "rev-parse" && args.includes("--verify")) return mergeHead;
        if (args[0] === "cat-file") throw new Error("not a valid object");
        if (args[0] === "fetch") throw new Error("couldn't find remote ref");
        return "";
      },
      validateFrg: async () => hmacSnapshot(head),
      observeMergedReleasePr: async () => mergedReleasePr(),
    },
  );
  assert.equal(result, "created");
  assert.ok(gitCalls.some((args) => args[0] === "tag" && args[1] === "-a" && args[2] === `v${intent.version}` && args[3] === mergeHead));
  assert.ok(gitCalls.some((args) => args[0] === "push" && args.includes(`refs/tags/v${intent.version}`)));
});

test("runEnsureAnnotatedReleaseTagCli rejects a valid OID that is not the merged release (#1151)", async () => {
  const gitCalls: string[][] = [];
  let validated = 0;
  await assert.rejects(
    runEnsureAnnotatedReleaseTagCli(
      {
        repoDir: "/repo",
        version: intent.version,
        mergeCommitOid: unrelatedOid,
        packedCandidate: head,
      },
      {
        git: async (args) => {
          gitCalls.push(args);
          if (args[0] === "rev-parse" && args.includes("--verify")) return unrelatedOid;
          if (args[0] === "cat-file") throw new Error("not a valid object");
          if (args[0] === "fetch") throw new Error("couldn't find remote ref");
          if (args[0] === "tag" || args[0] === "push") {
            throw new Error(`must not ${args[0]} an unrelated OID`);
          }
          return "";
        },
        validateFrg: async () => {
          validated++;
          return hmacSnapshot(head);
        },
        observeMergedReleasePr: async () => mergedReleasePr(mergeHead),
      },
    ),
    /not the merge commit of the v1\.34\.0 release PR/,
  );
  assert.equal(validated, 0);
  assert.ok(!gitCalls.some((args) => args[0] === "tag"));
  assert.ok(!gitCalls.some((args) => args[0] === "push"));
});

test("assertEnsureTagOidIsMergedRelease rejects an unrelated OID", () => {
  assert.throws(
    () => assertEnsureTagOidIsMergedRelease({
      version: intent.version,
      mergeCommitOid: unrelatedOid,
      observed: mergedReleasePr(mergeHead),
    }),
    /not the merge commit of the v1\.34\.0 release PR/,
  );
  assert.doesNotThrow(() => assertEnsureTagOidIsMergedRelease({
    version: intent.version,
    mergeCommitOid: mergeHead,
    observed: mergedReleasePr(mergeHead),
  }));
});

test("resolveEnsureTagOwnerRepo uses origin remote when cfg.repo is empty (#1163)", () => {
  assert.equal(resolveEnsureTagOwnerRepo("", "git@github.com:accidental-hedge-fund/agent-pipeline.git"),
    "accidental-hedge-fund/agent-pipeline");
  assert.equal(
    resolveEnsureTagOwnerRepo("", "https://github.com/accidental-hedge-fund/agent-pipeline.git"),
    "accidental-hedge-fund/agent-pipeline",
  );
  assert.equal(resolveEnsureTagOwnerRepo("cfg/repo", "git@github.com:other/x.git"), "cfg/repo");
  assert.equal(resolveEnsureTagOwnerRepo("", null), "");
  assert.equal(resolveEnsureTagOwnerRepo("", "not-a-github-url"), "");
});

test("runEnsureAnnotatedReleaseTagCli observes via origin remote when repo is empty (#1163)", async () => {
  const calls: string[][] = [];
  const result = await runEnsureAnnotatedReleaseTagCli(
    {
      repoDir: "/repo",
      repo: "",
      version: intent.version,
      mergeCommitOid: mergeHead,
      packedCandidate: head,
    },
    {
      git: missingTagGit(calls),
      validateFrg: async () => hmacSnapshot(head),
      observeMergedReleasePr: async () => mergedReleasePr(),
      gitRemoteUrl: async () => "git@github.com:accidental-hedge-fund/agent-pipeline.git",
    },
  );
  assert.equal(result, "created");
});

test("runEnsureAnnotatedReleaseTagCli fails closed without a repo directory", async () => {
  await assert.rejects(
    runEnsureAnnotatedReleaseTagCli(
      {
        repoDir: "",
        version: intent.version,
        mergeCommitOid: mergeHead,
        packedCandidate: head,
      },
      {
        git: async () => {
          throw new Error("git must not run");
        },
      },
    ),
    /cannot run without a repository directory/,
  );
});

function missingTagGit(calls: string[][], peel = mergeHead) {
  return async (args: string[]) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args.includes("--verify")) return peel;
    if (args[0] === "cat-file") throw new Error("not a valid object");
    if (args[0] === "fetch") throw new Error("couldn't find remote ref");
    if (args[0] === "tag" || args[0] === "push") return "";
    return "";
  };
}

test("ensure-tag tags the peeled merge when packed SHA differs from merge (#1149)", async () => {
  const calls: string[][] = [];
  const result = await ensureAnnotatedReleaseTag({
    version: intent.version,
    mergeCommitOid: mergeHead,
    packedCandidate: head,
    git: missingTagGit(calls),
    validateFrg: async () => hmacSnapshot(head),
  });
  assert.equal(result, "created");
  const tagCall = calls.find((args) => args[0] === "tag");
  assert.deepEqual(tagCall?.slice(0, 4), ["tag", "-a", `v${intent.version}`, mergeHead]);
  assert.notEqual(head, mergeHead);
});

test("ensure-tag fails closed on missing packed-candidate (#1149)", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    ensureAnnotatedReleaseTag({
      version: intent.version,
      mergeCommitOid: mergeHead,
      packedCandidate: "",
      git: missingTagGit(calls),
      validateFrg: async () => hmacSnapshot(head),
    }),
    /packed candidate must be a 40-character git OID/,
  );
  assert.ok(!calls.some((args) => args[0] === "tag" || args[0] === "push"));
});

test("ensure-tag fails closed when HMAC candidate_git_sha is unbound (#1149)", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    ensureAnnotatedReleaseTag({
      version: intent.version,
      mergeCommitOid: mergeHead,
      packedCandidate: head,
      git: missingTagGit(calls),
      validateFrg: async () => hmacSnapshot(unrelatedOid),
    }),
    /not this ship's packed candidate/,
  );
  assert.ok(!calls.some((args) => args[0] === "tag" || args[0] === "push"));
});

test("ensure-tag fails closed when HMAC candidate_git_sha is pin P and packed is C (#1298)", async () => {
  const packedC = "6670cee2b2659bc8350e98c1a2a34b53299b995b";
  const pinP = "a884d1ed9303eb32bc486063d976c5ad28c74553";
  const calls: string[][] = [];
  await assert.rejects(
    ensureAnnotatedReleaseTag({
      version: intent.version,
      mergeCommitOid: mergeHead,
      packedCandidate: packedC,
      git: missingTagGit(calls),
      validateFrg: async () => hmacSnapshot(pinP),
    }),
    /HMAC candidate_git_sha is not this ship's packed candidate/,
  );
  assert.ok(!calls.some((args) => args[0] === "tag" || args[0] === "push"));
});

test("ensure-tag accepts HMAC bound to packed C while control HEAD is out of band (#1298)", async () => {
  const packedC = "6670cee2b2659bc8350e98c1a2a34b53299b995b";
  const calls: string[][] = [];
  const result = await ensureAnnotatedReleaseTag({
    version: intent.version,
    mergeCommitOid: mergeHead,
    packedCandidate: packedC,
    git: missingTagGit(calls),
    validateFrg: async () => hmacSnapshot(packedC),
  });
  assert.equal(result, "created");
  assert.ok(!calls.some((args) => args[0] === "rev-parse" && args[1] === "HEAD"));
  const tagCall = calls.find((args) => args[0] === "tag");
  assert.deepEqual(tagCall?.slice(0, 4), ["tag", "-a", `v${intent.version}`, mergeHead]);
});

test("ensure-tag fails closed when on-disk FRG validation fails (#1149)", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    ensureAnnotatedReleaseTag({
      version: intent.version,
      mergeCommitOid: mergeHead,
      packedCandidate: head,
      git: missingTagGit(calls),
      validateFrg: async () => {
        throw new Error("FRG evidence is not release-eligible missing at .agent-pipeline/frg/1.34.0/latest.json");
      },
    }),
    /missing at/,
  );
  assert.ok(!calls.some((args) => args[0] === "tag" || args[0] === "push"));
});

test("ensure-tag fails closed when HMAC candidate_git_sha is missing (#1149)", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    ensureAnnotatedReleaseTag({
      version: intent.version,
      mergeCommitOid: mergeHead,
      packedCandidate: head,
      git: missingTagGit(calls),
      validateFrg: async () => hmacSnapshot(null),
    }),
    /no candidate_git_sha/,
  );
  assert.ok(!calls.some((args) => args[0] === "tag" || args[0] === "push"));
});

test("ensure-tag fails closed on lightweight existing tag and does not force (#1149)", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    ensureAnnotatedReleaseTag({
      version: intent.version,
      mergeCommitOid: mergeHead,
      packedCandidate: head,
      git: async (args) => {
        calls.push(args);
        if (args[0] === "rev-parse" && args.includes("--verify")) return mergeHead;
        if (args[0] === "cat-file") return "commit";
        throw new Error(`must not ${args.join(" ")}`);
      },
      validateFrg: async () => {
        throw new Error("must not validate lightweight tag");
      },
    }),
    /must be an annotated tag/,
  );
  assert.ok(!calls.some((args) => args[0] === "tag" || args[0] === "push" || args.includes("-f")));
});

test("ensure-tag fails closed on wrong-target existing tag and does not force (#1149)", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    ensureAnnotatedReleaseTag({
      version: intent.version,
      mergeCommitOid: mergeHead,
      packedCandidate: head,
      git: async (args) => {
        calls.push(args);
        if (args[0] === "rev-parse" && args.includes("--verify")) return mergeHead;
        if (args[0] === "cat-file") return "tag";
        if (args[0] === "rev-parse") return unrelatedOid;
        throw new Error(`must not ${args.join(" ")}`);
      },
      validateFrg: async () => {
        throw new Error("must not validate wrong existing tag");
      },
    }),
    /does not point to the release merge commit/,
  );
  assert.ok(!calls.some((args) => args[0] === "tag" || args[0] === "push" || args.includes("--force")));
});

test("ensure-tag treats a correct origin tag as exists when the local ref is missing (#1149)", async () => {
  const calls: string[][] = [];
  let validated = 0;
  const result = await ensureAnnotatedReleaseTag({
    version: intent.version,
    mergeCommitOid: mergeHead,
    packedCandidate: head,
    git: async (args) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args.includes("--verify")) return mergeHead;
      if (args[0] === "cat-file" && args[2] === `refs/tags/v${intent.version}`) {
        throw new Error("not a valid object");
      }
      if (
        args[0] === "fetch" &&
        args.includes(`refs/tags/v${intent.version}:refs/tags/v${intent.version}-origin-observe`)
      ) {
        return "";
      }
      if (args[0] === "cat-file" && args[2] === `refs/tags/v${intent.version}-origin-observe`) {
        return "tag";
      }
      if (args[0] === "rev-parse" && args[1] === `refs/tags/v${intent.version}-origin-observe^{}`) {
        return mergeHead;
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    validateFrg: async () => {
      validated++;
      throw new Error("must not require on-disk HMAC when origin already has the correct tag");
    },
  });
  assert.equal(result, "exists");
  assert.equal(validated, 0);
  assert.ok(!calls.some((args) => args[0] === "tag" || args[0] === "push"));
  assert.ok(!calls.some((args) => args.includes("-f") || args.includes("--force")));
});

test("ensure-tag fails closed on a wrong origin tag when the local ref is missing (#1149)", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    ensureAnnotatedReleaseTag({
      version: intent.version,
      mergeCommitOid: mergeHead,
      packedCandidate: head,
      git: async (args) => {
        calls.push(args);
        if (args[0] === "rev-parse" && args.includes("--verify")) return mergeHead;
        if (args[0] === "cat-file" && args[2] === `refs/tags/v${intent.version}`) {
          throw new Error("not a valid object");
        }
        if (args[0] === "fetch") return "";
        if (args[0] === "cat-file") return "tag";
        if (args[0] === "rev-parse") return unrelatedOid;
        throw new Error(`must not ${args.join(" ")}`);
      },
      validateFrg: async () => {
        throw new Error("must not validate FRG when origin tag is wrong");
      },
    }),
    /does not point to the release merge commit/,
  );
  assert.ok(!calls.some((args) => args[0] === "tag" || args[0] === "push"));
  assert.ok(!calls.some((args) => args.includes("-f") || args.includes("--force")));
});

test("ensure-tag concurrent push: correct remote tag is exists (#1149)", async () => {
  const calls: string[][] = [];
  const result = await ensureAnnotatedReleaseTag({
    version: intent.version,
    mergeCommitOid: mergeHead,
    packedCandidate: head,
    git: async (args) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args.includes("--verify")) return mergeHead;
      if (args[0] === "cat-file" && args[2] === `refs/tags/v${intent.version}`) {
        throw new Error("not a valid object");
      }
      if (args[0] === "tag") return "";
      if (args[0] === "push") throw new Error("rejected: already exists");
      if (args[0] === "fetch") return "";
      if (args[0] === "cat-file") return "tag";
      if (args[0] === "rev-parse") return mergeHead;
      return "";
    },
    validateFrg: async () => hmacSnapshot(head),
  });
  assert.equal(result, "exists");
  assert.ok(calls.some((args) => args[0] === "fetch" && args.includes(`refs/tags/v${intent.version}:refs/tags/v${intent.version}-origin-observe`)));
  assert.ok(!calls.some((args) => args.includes("-f") || args.includes("--force")));
});

test("ensure-tag concurrent push: wrong remote tag fails closed (#1149)", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    ensureAnnotatedReleaseTag({
      version: intent.version,
      mergeCommitOid: mergeHead,
      packedCandidate: head,
      git: async (args) => {
        calls.push(args);
        if (args[0] === "rev-parse" && args.includes("--verify")) return mergeHead;
        if (args[0] === "cat-file" && args[2] === `refs/tags/v${intent.version}`) {
          throw new Error("not a valid object");
        }
        if (args[0] === "tag") return "";
        if (args[0] === "push") throw new Error("rejected: already exists");
        if (args[0] === "fetch") return "";
        if (args[0] === "cat-file") return "commit";
        return "";
      },
      validateFrg: async () => hmacSnapshot(head),
    }),
    /must be an annotated tag/,
  );
  assert.ok(!calls.some((args) => args.includes("-f") || args.includes("--force")));
});

test("ensure-tag binds packed candidate to the HMAC-validated snapshot without a second latest.json read (#1149)", async () => {
  const calls: string[][] = [];
  let validateCalls = 0;
  const result = await ensureAnnotatedReleaseTag({
    version: intent.version,
    mergeCommitOid: mergeHead,
    packedCandidate: head,
    git: missingTagGit(calls),
    validateFrg: async () => {
      validateCalls++;
      return hmacSnapshot(head);
    },
  });
  assert.equal(result, "created");
  assert.equal(validateCalls, 1);
  assert.ok(calls.some((args) => args[0] === "tag"));
});

test("ensure-tag retries push when local annotated tag exists but origin lacks it (#1149)", async () => {
  const firstCalls: string[][] = [];
  await assert.rejects(
    ensureAnnotatedReleaseTag({
      version: intent.version,
      mergeCommitOid: mergeHead,
      packedCandidate: head,
      git: async (args) => {
        firstCalls.push(args);
        if (args[0] === "rev-parse" && args.includes("--verify")) return mergeHead;
        if (args[0] === "cat-file") throw new Error("not a valid object");
        if (args[0] === "tag") return "";
        if (args[0] === "push") throw new Error("transient: failed to push");
        if (args[0] === "fetch") throw new Error("couldn't find remote ref");
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
      validateFrg: async () => hmacSnapshot(head),
    }),
    /couldn't find remote ref/,
  );
  assert.ok(firstCalls.some((args) => args[0] === "tag"));
  assert.ok(firstCalls.some((args) => args[0] === "push"));

  const retryCalls: string[][] = [];
  const result = await ensureAnnotatedReleaseTag({
    version: intent.version,
    mergeCommitOid: mergeHead,
    packedCandidate: head,
    git: async (args) => {
      retryCalls.push(args);
      if (args[0] === "rev-parse" && args.includes("--verify")) return mergeHead;
      if (args[0] === "cat-file" && args[2] === `refs/tags/v${intent.version}`) return "tag";
      if (args[0] === "rev-parse" && args[1] === `refs/tags/v${intent.version}^{}`) return mergeHead;
      if (args[0] === "fetch") throw new Error("couldn't find remote ref");
      if (args[0] === "push") return "";
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    validateFrg: async () => {
      throw new Error("must not re-validate HMAC when retrying an already-created local tag");
    },
  });
  assert.equal(result, "created");
  assert.ok(retryCalls.some((args) => args[0] === "push" && args.includes(`refs/tags/v${intent.version}`)));
  assert.ok(!retryCalls.some((args) => args[0] === "tag"));
  assert.ok(!retryCalls.some((args) => args.includes("-f") || args.includes("--force")));
});

test("ensure-tag fails closed when origin has a wrong tag even if local is correct (#1149)", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    ensureAnnotatedReleaseTag({
      version: intent.version,
      mergeCommitOid: mergeHead,
      packedCandidate: head,
      git: async (args) => {
        calls.push(args);
        if (args[0] === "rev-parse" && args.includes("--verify")) return mergeHead;
        if (args[0] === "cat-file" && args[2] === `refs/tags/v${intent.version}`) return "tag";
        if (args[0] === "rev-parse" && args[1] === `refs/tags/v${intent.version}^{}`) return mergeHead;
        if (args[0] === "fetch") return "";
        if (args[0] === "cat-file") return "tag";
        if (args[0] === "rev-parse") return unrelatedOid;
        throw new Error(`must not ${args.join(" ")}`);
      },
      validateFrg: async () => {
        throw new Error("must not validate when origin tag is wrong");
      },
    }),
    /does not point to the release merge commit/,
  );
  assert.ok(!calls.some((args) => args[0] === "push" || args[0] === "tag" || args.includes("-f")));
});

test("hmacPackedCandidateGitShaFromUnknown prefers factory_release_binding (#1149)", () => {
  assert.equal(
    hmacPackedCandidateGitShaFromUnknown({
      factory_release_binding: { candidate_git_sha: head },
      pack_provenance: { candidate_git_sha: unrelatedOid },
    }),
    head,
  );
  assert.equal(
    hmacPackedCandidateGitShaFromUnknown({
      pack_provenance: { candidate_git_sha: unrelatedOid },
    }),
    unrelatedOid,
  );
  assert.equal(hmacPackedCandidateGitShaFromUnknown({}), null);
});

test("hmacPackedCandidateGitShaFromUnknown does not fall back from a present invalid binding (#1149)", () => {
  assert.equal(
    hmacPackedCandidateGitShaFromUnknown({
      factory_release_binding: { candidate_git_sha: "not-a-sha" },
      pack_provenance: { candidate_git_sha: head },
    }),
    null,
  );
  assert.equal(
    hmacPackedCandidateGitShaFromUnknown({
      factory_release_binding: {},
      pack_provenance: { candidate_git_sha: head },
    }),
    null,
  );
  assert.equal(
    hmacPackedCandidateGitShaFromUnknown({
      factory_release_binding: { candidate_git_sha: head },
      notes: [`factory_release_binding:${JSON.stringify({ candidate_git_sha: unrelatedOid })}`],
      pack_provenance: { candidate_git_sha: unrelatedOid },
    }),
    head,
  );
});

test("ensure-tag does not tag when factory_release_binding is overlaid after HMAC sign (#1149)", async () => {
  const version = "1.30.0";
  const signed = computeFrgEvidence({
    version,
    run_id: "frg-overlay-tag",
    loop_run_id: "loop-overlay-tag",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready", ready_clean: true },
      { item_id: "2", state: "ready", ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
    ...frgPassUniqueOperations(version),
  });
  assert.equal(signed.pass, true);
  const overlaid = {
    ...signed,
    factory_release_binding: { candidate_git_sha: head },
  };
  const calls: string[][] = [];
  await assert.rejects(
    ensureAnnotatedReleaseTag({
      version,
      mergeCommitOid: mergeHead,
      packedCandidate: head,
      git: missingTagGit(calls),
      validateFrg: async () =>
        validateReleaseEligibleFrgEvidence(overlaid, version, {
          attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
        }),
    }),
    /attestation MAC|forged|does not match/i,
  );
  assert.ok(!calls.some((args) => args[0] === "tag" || args[0] === "push"));
});

test("runEnsureAnnotatedReleaseTagCli fails closed without --packed-candidate (#1149)", async () => {
  await assert.rejects(
    runEnsureAnnotatedReleaseTagCli(
      {
        repoDir: "/repo",
        version: intent.version,
        mergeCommitOid: mergeHead,
        packedCandidate: "not-a-sha",
      },
      {
        git: async () => {
          throw new Error("git must not run");
        },
      },
    ),
    /packed candidate must be a 40-character git OID/,
  );
});

test("real coordinator defaults spawn candidate ensure-tag leaf and persist request (review 2)", () => {
  const shipAdapter = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "stages", "ship-adapter.ts"),
    "utf8",
  );
  const shipCode = shipAdapter
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.match(
    shipCode,
    /shipEndLeafArgv\(\s*"ensure-tag"/,
    "waitForPublication must spawn candidate release ensure-tag when pin SHA differs",
  );
  assert.doesNotMatch(
    shipCode,
    /spawnEnsureTag:\s*opts\.spawnEnsureTag\s*\?\?\s*\(\(engine,\s*tagOpts\)\s*=>\s*defaultSpawnCandidateEnsureTag/,
    "real coordinator must not default tag to pin-process ensureAnnotatedReleaseTag",
  );
  assert.ok(
    !shipCode.includes("defaultSpawnCandidateEnsureTag"),
    "pin-process defaultSpawnCandidateEnsureTag must not remain as the candidate tag handoff",
  );
  assert.match(
    shipCode,
    /resolveFactoryReleaseRequestPath:\s*opts\.resolveFactoryReleaseRequestPath\s*\?\?/,
    "realShipCoordinatorDeps must default the factory-release request persist/resume path",
  );
  assert.ok(
    shipCode.includes("persistShipFactoryReleaseRequest"),
    "real coordinator must persist a ship-bound factory-release request when path is omitted",
  );
  const dest = persistedShipFactoryReleaseRequestPath(intent, { AGENT_PIPELINE_STATE_HOME: "/tmp/ap-state" });
  assert.ok(path.isAbsolute(dest));
  assert.match(dest, /factory-release-prepare-request\.json$/);
  assert.ok(dest.includes("ships"));
  assert.ok(
    dest.startsWith("/tmp/ap-state"),
    "in-engine ship request dest must resolve under AGENT_PIPELINE_STATE_HOME",
  );
  assert.equal(
    isPathInsideCheckout(dest, "/repo"),
    false,
    "in-engine ship request dest must not resolve inside the target checkout",
  );
  assert.ok(
    !dest.includes(`${path.sep}.agent-pipeline${path.sep}`),
    "in-engine ship must not write the request under REPO_DIR/.agent-pipeline/",
  );
});

test("persistShipFactoryReleaseRequest writes a secret-free request and reuses it", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ship-frg-req-"));
  const repoDir = path.join(tmp, "repo");
  const stateHome = path.join(tmp, "state");
  const manifestDir = path.join(repoDir, "core/scripts/frg-packs/factory-gate-v1");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, "manifest.json"), JSON.stringify({ pack_id: "factory-gate-v1" }));
  const env = { AGENT_PIPELINE_STATE_HOME: stateHome };
  try {
    const first = await persistShipFactoryReleaseRequest(intent, train, { repoDir, env });
    const second = await persistShipFactoryReleaseRequest(intent, train, { repoDir, env });
    assert.equal(first, second);
    assert.equal(
      isPathInsideCheckout(first, repoDir),
      false,
      "in-engine ship request dest must not resolve inside REPO_DIR",
    );
    const request = JSON.parse(fs.readFileSync(first, "utf8")) as Record<string, unknown>;
    assert.equal(request.kind, "factory_release_prepare_request");
    assert.equal(request.target_version, intent.version);
    assert.deepEqual(request.integrated_candidate, { git_sha: head });
    assert.equal(request.PIPELINE_FRG_ATTESTATION_KEY, undefined);
    assert.equal(request.pass, undefined);
    assert.equal(request.credential, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
