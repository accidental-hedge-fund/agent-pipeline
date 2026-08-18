import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  alignReleaseCheckoutToCandidate,
  assertFrgCandidateProvenance,
  shipCoordinatorDepsFromOperations,
  verifyAnnotatedReleaseTag,
  type ShipAdapterOperations,
} from "../scripts/stages/ship-adapter.ts";
import type {
  ShipIntent,
  ShipStateStore,
  ShipStatus,
  ShipTrainEvidence,
} from "../scripts/stages/ship.ts";
import type { FrgEvidence } from "../scripts/factory-reliability-gate.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const head = "a".repeat(40);
const releaseHead = "b".repeat(40);
const mergeHead = "c".repeat(40);

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
};

const promotion = {
  version: intent.version,
  tag: `v${intent.version}`,
  verified: true as const,
  installed_version: intent.version,
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

test("ship adapter returns the one frozen train plan from its planning seam", async () => {
  const deps = shipCoordinatorDepsFromOperations(operations({
    planTrain: async () => ({ ordered_issues: [11, 10] }),
  }), { state });

  assert.deepEqual(await deps.planTrain(intent), { ordered_issues: [11, 10] });
});

test("ship adapter continues when FRG evidence is missing", async () => {
  const deps = shipCoordinatorDepsFromOperations(operations({
    observeFrg: async () => null,
  }), { state });

  const pack = await deps.convergeFrgPack(intent, train);
  assert.equal(pack.complete, true);
  assert.equal(pack.loop_run_id, `no-frg-${intent.version}`);
  assert.equal(pack.candidate_head_oid, train.integrated_head_oid);
});

test("ship adapter never rebinds provenance-free FRG evidence to a candidate", () => {
  // Post-pilot (1.34+) without durable binding fails closed.
  assert.throws(
    () => assertFrgCandidateProvenance(frg, train, intent),
    /no durable candidate binding/,
  );
  // Post-pilot with matching durable binding is accepted (no hybrid provenance).
  assert.doesNotThrow(() =>
    assertFrgCandidateProvenance(frg, train, intent, {
      durableCandidateGitSha: train.integrated_head_oid,
    }),
  );
  // Hybrid provenance on post-pilot is refused.
  const hybridOnPostPilot = {
    ...frg,
    pack_provenance: {
      candidate_git_sha: train.integrated_head_oid,
      repository: intent.repository,
      base_branch: intent.base_branch,
    },
  } as unknown as FrgEvidence;
  assert.throws(
    () => assertFrgCandidateProvenance(hybridOnPostPilot, train, intent),
    /hybrid pack_provenance is valid only for v1\.33\.0/,
  );
  const mismatched = {
    ...frg,
    pack_provenance: {
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
  assert.deepEqual(calls, []);
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
