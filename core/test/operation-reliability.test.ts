// Unique-operation classifier (#1368). Injected events/run metas/manifest only.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_LIFECYCLE_CLASSES_1333,
  REQUIRED_PUBLIC_ENTRYPOINTS,
  REQUIRED_ADMISSION_ROUTES,
  admissionRouteExecutionGaps,
  admissionRouteInventoryGaps,
  assertAdmissionRouteInventoryComplete,
  captureRequiredAdmissionRouteCrossings,
  delegateGeneratedHostNumericDrive,
  aggregateUniqueOperationReliability,
  attemptsFromRunArtifacts,
  filterAttemptsBoundToCandidate,
  mapPublicEntrypointFromRunId,
  passingUniqueOperationAttempts,
  passingUniqueOperationManifest,
  reconcileCompletedSideEffect,
  uniqueOperationReleaseBindingFailure,
  uniqueOperationSloFailure,
} from "../scripts/operation-reliability.ts";
import {
  SKILL_HOST_IDS,
} from "../scripts/host-skill.ts";
import {
  executeAfterPublicAdmission,
  handleRunSubcommand,
  runLoopCommand,
  runSingleIssueCommand,
  type CliOpts,
  type LoopCliDeps,
  type RunSubcommandDeps,
  type SingleIssueCommandDeps,
} from "../scripts/pipeline.ts";
import { runTrain, type TrainDeps, type TrainIssueSnapshot } from "../scripts/stages/train.ts";
import {
  operatorShipIntent,
  runShipCoordinator,
  type ShipCoordinatorDeps,
  type ShipStatus,
} from "../scripts/stages/ship.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(CORE_ROOT, "..");

async function executeGeneratedHostNumericDrive(
  host: (typeof SKILL_HOST_IDS)[number],
  invokeCli: (argv: readonly string[]) => Promise<boolean>,
): Promise<boolean> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `pipeline-admission-host-${host}-`));
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, "hosts", host, "outer-host.manifest.json"),
      "utf8",
    )) as { profileDefault: string };
    const scriptsDir = path.join(temp, "scripts");
    const coreScripts = path.join(temp, "core", "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(coreScripts, { recursive: true });
    fs.mkdirSync(path.join(temp, "core", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(temp, "tmp"), { recursive: true });
    const template = fs.readFileSync(path.join(REPO_ROOT, "hosts", "_shared", "entry.template.mjs"), "utf8");
    const launcher = path.join(scriptsDir, "pipeline.mjs");
    fs.writeFileSync(launcher, template.replaceAll("__PROFILE__", manifest.profileDefault));
    fs.copyFileSync(
      path.join(REPO_ROOT, "scripts", "ensure-engines-node.mjs"),
      path.join(scriptsDir, "ensure-engines-node.mjs"),
    );
    fs.writeFileSync(path.join(temp, "core", "package.json"), JSON.stringify({ version: "0.0.0-test" }));
    fs.writeFileSync(
      path.join(coreScripts, "pipeline.ts"),
      "console.log(JSON.stringify(process.argv.slice(2)));\n",
    );
    const result = spawnSync(process.execPath, [launcher, "1454"], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: path.join(temp, "tmp") },
    });
    assert.equal(result.status, 0, `${host} generated launcher failed: ${result.stderr}`);
    const forwarded = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "null") as string[];
    assert.deepEqual(forwarded, ["1454", "--profile", manifest.profileDefault]);
    return invokeCli([forwarded[0]!]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

import {
  computeFrgEvidence,
  FRG_PACK_MANIFEST,
  FRG_UNIT_TEST_ATTESTATION_KEY,
  frgRequiredCompositionOverrides,
  frgRequiredObservationOverrides,
  isReleaseEligibleFrgPass,
  runFactoryGate,
  validateReleaseEligibleFrgEvidence,
  verifyFrgAttestation,
  type FrgFsDeps,
} from "../scripts/factory-reliability-gate.ts";

test("required admission route inventory is exact and hard-gated (#1454)", () => {
  assert.doesNotThrow(() => assertAdmissionRouteInventoryComplete());
  assert.deepEqual(admissionRouteInventoryGaps(), []);

  const missing = REQUIRED_ADMISSION_ROUTES.filter((row) => row.route !== "merge.train-nested");
  assert.throws(() => assertAdmissionRouteInventoryComplete(missing), /missing route merge\.train-nested/);

  const duplicate = [...REQUIRED_ADMISSION_ROUTES, REQUIRED_ADMISSION_ROUTES[0]!];
  assert.throws(() => assertAdmissionRouteInventoryComplete(duplicate), /duplicate route drive\.numeric/);

  const unknown = [
    ...REQUIRED_ADMISSION_ROUTES,
    { route: "invented", entrypoint: "invented", class: "direct", boundary: "public-admission" },
  ] as never;
  assert.throws(() => assertAdmissionRouteInventoryComplete(unknown), /unknown route invented.*unknown entrypoint invented/);

  const nameOnly = REQUIRED_ADMISSION_ROUTES.map((row) =>
    row.route === "single.direct" ? { ...row, boundary: "" } : row,
  ) as never;
  assert.throws(() => assertAdmissionRouteInventoryComplete(nameOnly), /bypasses admission/);

});

function admissionCfg(): PipelineConfig {
  return {
    ...DEFAULT_CONFIG,
    repo: "acme/repo",
    repo_dir: "/factory-control",
    domain: "acme+repo",
    base_branch: "main",
  };
}

function acknowledgedAdmission(input: {
  operationKey?: string;
  logicalOperationId?: string;
  approvedRoot?: string | null;
}) {
  return {
    acknowledged: true as const,
    operationKey: input.operationKey ?? "",
    logicalOperationId: input.logicalOperationId ?? "lop-admitted",
    approvedRoot: input.approvedRoot ?? "/factory-control",
  };
}

async function withCapturedConsole<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

function driveEngineResult(runId: string) {
  return {
    kind: "drive" as const,
    result: {
      runId,
      cycles: 1,
      stop: null,
      holdOutstanding: false,
      allDone: true,
      resumed: false,
      heldItemIds: [],
      dispatched: 1,
      excludedItemIds: [],
      exclusionReason: null,
      completion: "all_items_done" as const,
    },
  };
}

function fakeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-admission-loop-"));
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

function memAdmissionStore() {
  const files = new Map<string, string>();
  const enoent = (p: string): NodeJS.ErrnoException => {
    const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    e.code = "ENOENT";
    return e;
  };
  return {
    readFile: async (p: string) => {
      if (!files.has(p)) throw enoent(p);
      return files.get(p)!;
    },
    writeFile: async (p: string, data: string) => {
      files.set(p, data);
    },
    appendFile: async (p: string, data: string) => {
      files.set(p, (files.get(p) ?? "") + data);
    },
    mkdir: async () => {},
    readdir: async () => [],
    stat: async (p: string) => {
      if (!files.has(p)) throw enoent(p);
      return { mtime: new Date(0) };
    },
    rename: async (from: string, to: string) => {
      const contents = files.get(from);
      if (contents === undefined) throw enoent(from);
      files.set(to, contents);
      files.delete(from);
    },
    fsyncFile: async () => {},
    fsyncDirectory: async () => {},
    realpath: async (p: string) => path.resolve(p),
    link: async (existingPath: string, newPath: string) => {
      if (files.has(newPath)) {
        const error = new Error(`EEXIST: ${newPath}`) as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      const contents = files.get(existingPath);
      if (contents === undefined) throw enoent(existingPath);
      files.set(newPath, contents);
    },
    unlink: async (p: string) => {
      if (!files.delete(p)) throw enoent(p);
    },
  };
}

function trainAdmissionDeps(
  events: string[],
  persist: TrainDeps["persistPublicAdmission"],
): TrainDeps & {
  seedIssue(s: TrainIssueSnapshot): void;
  seedPr(issue: number, pr: number): void;
} {
  const issues = new Map<number, TrainIssueSnapshot>();
  const openPr = new Map<number, number>();
  const prState = new Map<number, { state: "open" | "merged"; oid: string | null; head: string }>();
  const store = memAdmissionStore();
  const deps: TrainDeps & {
    seedIssue(s: TrainIssueSnapshot): void;
    seedPr(issue: number, pr: number): void;
  } = {
    log() {},
    now: () => new Date("2026-08-28T17:28:03.000Z"),
    runStore: store,
    publicAdmissionStore: store,
    resolveApprovedControlRoot: async () => "/factory-control",
    persistPublicAdmission: persist,
    async getIssue(n) {
      const s = issues.get(n);
      if (!s) throw new Error(`missing issue ${n}`);
      return s;
    },
    async listMilestoneIssues() {
      return [...issues.values()];
    },
    discoverDeps: {
      async getIssueTitleBody(n) {
        const s = issues.get(n);
        return s ? { title: s.title, body: s.body } : null;
      },
      async getBlockedByIssueNumbers() {
        return [];
      },
      async getIssueOpenState(n) {
        return issues.get(n)?.state === "closed" ? "closed" : "open";
      },
    },
    async advanceWave(list) {
      const out = new Map();
      for (const n of list) {
        const s = issues.get(n)!;
        s.labels = ["pipeline:ready-to-deploy"];
        out.set(n, { ok: true as const, terminal: "ready-to-deploy" as const, labels: s.labels });
      }
      return out;
    },
    async getPrForIssue(n) {
      return openPr.get(n) ?? null;
    },
    async getPrForIssueAnyState(n) {
      return openPr.get(n) ?? null;
    },
    async mergeIssuePr(pr) {
      events.push(`protected:merge.train-nested:${pr}`);
      const cur = prState.get(pr) ?? { state: "open" as const, oid: null, head: "h" };
      prState.set(pr, {
        state: "merged",
        oid: `aa${pr}${"c".repeat(40)}`.slice(0, 40),
        head: cur.head,
      });
      for (const [issue, p] of openPr) if (p === pr) openPr.delete(issue);
    },
    async observePr(pr) {
      const cur = prState.get(pr) ?? { state: "open" as const, oid: null, head: "h" };
      return {
        state: cur.state === "merged" ? "merged" : "open",
        mergeCommitOid: cur.oid,
        headRefOid: cur.head,
      };
    },
    async fetchBase() {},
    async baseTip() {
      return "b".repeat(40);
    },
    async isAncestor(ancestor, descendant) {
      return descendant === "b".repeat(40) && ancestor.startsWith("aa");
    },
    seedIssue(s) {
      issues.set(s.number, s);
    },
    seedPr(issue, pr) {
      openPr.set(issue, pr);
      prState.set(pr, { state: "open", oid: null, head: "a".repeat(40) });
    },
  };
  return deps;
}

function shipAdmissionDeps(store: { status: ShipStatus | null }): ShipCoordinatorDeps {
  const boom = async (): Promise<never> => {
    throw new Error("stop after admission");
  };
  return {
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    state: {
      statusFile: (key) => `/state/ships/${key}/status.json`,
      eventsFile: (key) => `/state/ships/${key}/events.jsonl`,
      async read() {
        return store.status ? structuredClone(store.status) : null;
      },
      async writeAtomic(_key, value) {
        store.status = structuredClone(value);
      },
      async appendEvent() {},
    },
    authorizationPublicKey: "unused",
    async withRunLock(_key, fn) {
      return fn();
    },
    reconcile: boom,
    planTrain: boom,
    convergeTrain: boom,
    convergeFrgPack: boom,
    convergeFrgScore: boom,
    convergeReleasePrepare: boom,
    convergeReleaseFinish: boom,
    convergeTag: boom,
    waitForRelease: boom,
    convergeEnginePromote: boom,
    convergeDeployment: boom,
    async observeRemainingOpenMilestoneIssues() {
      return [];
    },
  };
}

test("hard gate executes inventoried production admission routes (#1454)", async () => {
  const events: string[] = [];
  const persist = (async (input: {
    operationKey?: string;
    logicalOperationId?: string;
    route?: string;
  }) => {
    events.push(`admit:${input.route ?? input.operationKey}`);
    return {
      ...acknowledgedAdmission({
        operationKey: input.operationKey,
        logicalOperationId: `lop-${input.route ?? "admitted"}`,
        approvedRoot: "/factory-control",
      }),
      runDir: "/factory-control/.agent-pipeline/runs/admission-test",
      runId: "admission-test",
    };
  }) as never;

  const captured = await captureRequiredAdmissionRouteCrossings(async () => {
    await withCapturedConsole(async () => {
      for (const [route, kind] of [
        ["merge.direct", "merge"],
        ["merge-queue.apply", "merge-queue"],
      ] as const) {
        const executed = await executeAfterPublicAdmission(
          {
            repoDir: "/factory-control",
            repo: "acme/repo",
            domain: "acme+repo",
            kind,
            operationKey: `inventory:${route}`,
            route,
          },
          async (admission) => {
            assert.equal(admission.logicalOperationId, `lop-${route}`);
            assert.equal(admission.approvedRoot, "/factory-control");
            events.push(`protected:${route}`);
          },
          { persistPublicAdmission: persist },
        );
        assert.equal(executed.ok, true);
        assert.deepEqual(events.slice(-2), [`admit:${route}`, `protected:${route}`]);
      }

      const singleDeps: SingleIssueCommandDeps = {
        resolveConfig: () => admissionCfg(),
        resolveIssueNumber: async (_cfg, n) => n,
        runLoopEngine: async (input) => {
          assert.equal(input.logicalOperationId, "lop-single.direct");
          events.push("protected:single.direct");
          return driveEngineResult("loop-single");
        },
        writeStdoutLine: () => {},
        persistPublicAdmission: persist,
      };
      await runSingleIssueCommand("1454", { profile: "codex" } as CliOpts, singleDeps, {
        persistPublicAdmission: true,
      });
      assert.deepEqual(events.slice(-2), ["admit:single.direct", "protected:single.direct"]);

      const numericDeps: SingleIssueCommandDeps = {
        resolveConfig: () => admissionCfg(),
        resolveIssueNumber: async (_cfg, n) => n,
        runLoopEngine: async () => {
          events.push("protected:drive.numeric");
          return driveEngineResult("loop-numeric");
        },
        writeStdoutLine: () => {},
      };
      await runSingleIssueCommand("1454", { profile: "codex" } as CliOpts, numericDeps);

      const detachDeps: RunSubcommandDeps = {
        spawnDetached: async () => {
          events.push("protected:drive.detached-resume");
          return { runDir: "/tmp/wrapper", pid: 1 };
        },
        findGitRoot: () => "/factory-control",
        cwd: () => "/factory-control",
        restoreDeadDetached: async () => null,
      };
      const priorExit = process.exitCode;
      process.exitCode = undefined;
      await handleRunSubcommand("1454", { detach: true, profile: "codex" } as CliOpts, detachDeps);
      process.exitCode = priorExit;
      assert.ok(events.includes("protected:drive.detached-resume"));

      const repoDir = fakeGitRepo();
      try {
        const loopDirect: LoopCliDeps = {
          runLoopPreflight: async () => ({
            ok: true,
            args: { selector: { type: "work-list", value: ["1454"] }, resumeRunId: undefined, audit: false },
          }),
          runLoopEngine: async () => {
            events.push("protected:loop.direct");
            return driveEngineResult("loop-direct");
          },
          writeStdoutLine: () => {},
        };
        await runLoopCommand({ profile: "codex", repoPath: repoDir } as CliOpts, ["1454"], loopDirect);

        const loopResume: LoopCliDeps = {
          runLoopPreflight: async () => ({
            ok: true,
            args: { selector: { type: "work-list", value: ["1454"] }, resumeRunId: "loop-resume-1", audit: false },
          }),
          runLoopEngine: async (input) => {
            assert.equal(input.resumeRunId, "loop-resume-1");
            events.push("protected:loop.resume");
            return { ...driveEngineResult("loop-resume-1"), result: { ...driveEngineResult("loop-resume-1").result, resumed: true } };
          },
          writeStdoutLine: () => {},
        };
        await runLoopCommand({ profile: "codex", repoPath: repoDir, resume: "loop-resume-1" } as CliOpts, [], loopResume);
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }

      const recovery = trainAdmissionDeps(events, persist);
      recovery.seedIssue({
        number: 11,
        title: "recovery",
        body: "independent",
        labels: ["pipeline:ready"],
        state: "open",
      });
      await runTrain(
        { issues: [11], merge: false, baseBranch: "main", repoDir: "/tmp/repo", repo: "acme/repo" },
        recovery,
      );
      events.push("protected:train.recovery");

      const nested = trainAdmissionDeps(events, persist);
      nested.seedIssue({
        number: 12,
        title: "merge",
        body: "independent",
        labels: ["pipeline:ready-to-deploy"],
        state: "open",
      });
      nested.seedPr(12, 112);
      await runTrain(
        { issues: [12], merge: true, baseBranch: "main", repoDir: "/tmp/repo", repo: "acme/repo" },
        nested,
      );
      events.push("protected:train.direct");

      const shipStore: { status: ShipStatus | null } = { status: null };
      const shipIntent = operatorShipIntent({
        repository: "acme/repo",
        base_branch: "main",
        milestone: "v1.40.1",
        version: "1.40.1",
      });
      await runShipCoordinator(shipIntent, null, shipAdmissionDeps(shipStore)).catch(() => {});
      events.push("protected:ship.direct");
      assert.ok(shipStore.status, "ship.direct must persist coordinator status");
      await runShipCoordinator(shipIntent, null, shipAdmissionDeps(shipStore)).catch(() => {});
      events.push("protected:ship.resume");

      for (const host of SKILL_HOST_IDS) {
        const delegated = await executeGeneratedHostNumericDrive(host, async (argv) => {
          return delegateGeneratedHostNumericDrive(host, argv, async (forwarded) => {
            assert.deepEqual(forwarded, ["1454"]);
            events.push(`protected:host.${host}`);
            return true;
          });
        });
        assert.equal(delegated, true);
      }
    });
  });

  assert.deepEqual(admissionRouteExecutionGaps(captured.routes), []);
  assert.ok(events.includes("protected:merge.train-nested:112"));
  assert.deepEqual(
    REQUIRED_ADMISSION_ROUTES.filter((row) => row.class === "host").map((row) => row.host).sort(),
    [...SKILL_HOST_IDS].sort(),
  );
  for (const host of SKILL_HOST_IDS) {
    const generated = fs.readFileSync(path.join(CORE_ROOT, "..", "hosts", host, "SKILL.md"), "utf8");
    assert.match(generated, /Host SKILL for the `pipeline` CLI/);
    assert.match(generated, /`pipeline <N>` starts the durable\s+one-item drive/);
  }
});

test("production public admission refusal executes no protected operation (#1454)", async () => {
  let protectedCalls = 0;
  const executed = await executeAfterPublicAdmission(
    {
      repoDir: "/factory-control",
      repo: "acme/repo",
      domain: "acme+repo",
      kind: "merge",
      operationKey: "inventory:merge.direct",
      route: "merge.direct",
    },
    async () => { protectedCalls += 1; },
    {
      persistPublicAdmission: (async () => ({
        acknowledged: false,
        kind: "merge",
        runId: "merge-refused",
        logicalOperationId: "lop-refused",
        repository: "acme/repo",
        domain: "acme+repo",
        issue: null,
        startedAt: "2026-09-05T00:00:00Z",
        approvedRoot: null,
        runDir: null,
        binding: {},
        failure: {
          kind: "approved_root_unavailable",
          step: "resolve_approved_root",
          diagnostic: "injected refusal",
        },
      })) as never,
    },
  );
  assert.equal(executed.ok, false);
  assert.equal(protectedCalls, 0);
});

function packInput(over: Record<string, unknown> = {}) {
  return {
    version: "1.30.0",
    run_id: "frg-uop",
    loop_run_id: "loop-uop",
    pack_id: FRG_PACK_MANIFEST.pack_id,
    items: [
      { item_id: "1", state: "ready" as const, ready_clean: true },
      { item_id: "2", state: "ready" as const, ready_clean: true },
    ],
    scenario_overrides: frgRequiredObservationOverrides("pass"),
    composition_overrides: frgRequiredCompositionOverrides("pass"),
    attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
    unique_operations: passingUniqueOperationAttempts(),
    unique_operation_manifest: passingUniqueOperationManifest({ release_identity: "1.30.0" }),
    matrix_covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
    ...over,
  };
}

test("aggregator: two physical runs of one logical operation count once", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "r1",
        logical_operation_id: "lop-L",
        postcondition_proof: true,
        nested: false,
        entrypoint: "single",
      },
      {
        run_id: "r2",
        logical_operation_id: "lop-L",
        postcondition_proof: true,
        nested: false,
        entrypoint: "single",
      },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.clean_completion.numerator, 1);
  assert.equal(report.clean_completion.denominator, 1);
  assert.equal(report.clean_completion.metric_kind, "unique_operation");
  assert.equal(report.operations.length, 1);
  assert.deepEqual(report.operations[0]!.run_ids, ["r1", "r2"]);
});

test("aggregator: zero-exit without postcondition proof is not verified success", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "r1",
        logical_operation_id: "lop-L",
        process_exit_zero: true,
        run_complete: true,
        issue_closed: true,
        ready_to_deploy_label: true,
        nested: false,
      },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.clean_completion.numerator, 0);
  assert.equal(report.ownerless_terminal.numerator, 1);
  assert.equal(report.operations[0]!.terminal, "ownerless_terminal");
});

test("aggregator: undeclared wait is not a stable exclusion", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "r1",
        logical_operation_id: "lop-L",
        terminal: "external_wait",
        fixture_id: "F",
        nested: false,
      },
    ],
    manifest: {
      required_entrypoints: [],
      required_lifecycle_classes: [],
      live_train_linkage_present: true,
    },
  });
  assert.equal(report.exclusions.length, 0);
  assert.equal(report.clean_completion.denominator, 1);
  assert.equal(report.clean_completion.numerator, 0);
});

test("aggregator: manifest-declared wait is a stable exclusion", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "r1",
        logical_operation_id: "lop-L",
        terminal: "external_wait",
        fixture_id: "F",
        nested: false,
      },
    ],
    manifest: {
      expected_outcomes: { F: "external_wait" },
      required_entrypoints: [],
      required_lifecycle_classes: [],
      live_train_linkage_present: true,
    },
  });
  assert.equal(report.exclusions.length, 1);
  assert.equal(report.exclusions[0]!.reason, "external_wait");
  assert.equal(report.clean_completion.denominator, 0);
});

test("aggregator: missing logical_operation_id is missing correlation, not an exclusion", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [{ run_id: "historical", process_exit_zero: true }],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.integrity.missing_correlation, 1);
  assert.equal(report.exclusions.length, 0);
  assert.equal(report.clean_completion.denominator, 0);
});

test("aggregator: nested attempts do not increment unique-operation success by themselves", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "parent",
        logical_operation_id: "lop-L",
        nested: false,
        postcondition_proof: true,
        entrypoint: "train",
      },
      {
        run_id: "child-single",
        logical_operation_id: "lop-L",
        nested: true,
        postcondition_proof: true,
        entrypoint: "single",
      },
      {
        run_id: "attestation-tick",
        logical_operation_id: "lop-L",
        nested: true,
        postcondition_proof: true,
        entrypoint: "ship",
      },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.clean_completion.numerator, 1);
  assert.equal(report.clean_completion.denominator, 1);
});

test("aggregator: false-human from composition/blocker classification", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "r1",
        logical_operation_id: "lop-L",
        nested: false,
        false_human: true,
        composition_false_human: true,
        terminal: "typed_request",
      },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
    composition_false_human_count: 1,
  });
  assert.equal(report.false_human_projection.numerator, 1);
  assert.equal(report.operations[0]!.terminal, "false_human_projection");
});

test("aggregator: ownerless terminal is not success, wait, or cancellation", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [{ run_id: "r1", logical_operation_id: "lop-L", nested: false }],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.ownerless_terminal.numerator, 1);
  assert.equal(report.clean_completion.numerator, 0);
  assert.notEqual(report.operations[0]!.terminal, "cancellation");
  assert.notEqual(report.operations[0]!.terminal, "external_wait");
  assert.notEqual(report.operations[0]!.terminal, "verified_success");
});

test("aggregator: retry keyed by run_id would double-count — keys by logical id", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      { run_id: "a", logical_operation_id: "lop-L", nested: false, postcondition_proof: true },
      { run_id: "b", logical_operation_id: "lop-L", nested: false, postcondition_proof: true },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.notEqual(report.clean_completion.denominator, 2, "must not key unique-operation success by run_id");
  assert.equal(report.clean_completion.denominator, 1);
});

test("reconcileCompletedSideEffect: later proof does not replay the mutation", () => {
  let mutations = 0;
  const first = reconcileCompletedSideEffect({
    alreadyCompleted: false,
    mutate: () => {
      mutations += 1;
      return "created";
    },
  });
  assert.equal(first.completed, true);
  assert.equal(first.replayed, false);
  assert.equal(mutations, 1);
  const second = reconcileCompletedSideEffect({
    alreadyCompleted: true,
    mutate: () => {
      mutations += 1;
      return "replay";
    },
  });
  assert.equal(second.completed, true);
  assert.equal(second.replayed, false);
  assert.equal(second.value, null);
  assert.equal(mutations, 1, "second mutation must not run");
});

test("aggregator: sibling halt on contained peer failure refuses independent-sibling rate", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "peer",
        logical_operation_id: "lop-peer",
        nested: false,
        independent_sibling_continuation: false,
      },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.independent_sibling_continuation.denominator, 1);
  assert.equal(report.independent_sibling_continuation.numerator, 0);
  assert.equal(report.independent_sibling_continuation.ratio, 0);
});

test("aggregator: applicable exact-candidate recovery at 100%", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "r1",
        logical_operation_id: "lop-L",
        nested: false,
        postcondition_proof: true,
        exact_candidate_recovery: true,
      },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.exact_candidate_recovery.ratio, 1);
});

test("attemptsFromRunArtifacts: missing minted id uses run_id fallback identity", () => {
  const attempts = attemptsFromRunArtifacts([
    {
      runId: "old",
      runJson: { run_id: "old" },
      events: [{ type: "run_start", run_id: "old" }],
      summary: { finalState: "ready-to-deploy" },
    },
  ]);
  assert.equal(attempts[0]!.logical_operation_id, "old");
  assert.equal(attempts[0]!.identity_provenance, "run_id_fallback");
  const report = aggregateUniqueOperationReliability({
    attempts,
    manifest: {
      required_entrypoints: [],
      required_lifecycle_classes: [],
      live_train_linkage_present: true,
    },
  });
  assert.equal(report.integrity.missing_correlation, 0);
  assert.equal(report.clean_completion.numerator, 0);
  assert.equal(report.clean_completion.denominator, 0);
  assert.equal(report.ownerless_terminal.numerator, 0);
});

test("attemptsFromRunArtifacts: contradictory identity sources increment contradictory_correlation", () => {
  const attempts = attemptsFromRunArtifacts([
    {
      runId: "r1",
      runJson: { run_id: "r1", logical_operation_id: "L1" },
      events: [{ type: "run_start", run_id: "r1", logical_operation_id: "L2" }],
      summary: { logical_operation_id: "L1" },
    },
  ]);
  assert.equal(attempts[0]!.contradictory_identity, true);
  assert.ok(attempts[0]!.logical_operation_id);
  const report = aggregateUniqueOperationReliability({
    attempts,
    manifest: {
      required_entrypoints: [],
      required_lifecycle_classes: [],
      live_train_linkage_present: true,
    },
  });
  assert.ok(report.integrity.contradictory_correlation > 0);
  assert.equal(uniqueOperationSloFailure({ ...report, candidate_sha: "a".repeat(40), release_identity: "1.30.0" }), "contradictory correlation (1)");
});

test("attemptsFromRunArtifacts: uses run_start.entrypoint and does not coerce other kinds to single", () => {
  const drive = attemptsFromRunArtifacts([
    {
      runId: "drive-1",
      runJson: { run_id: "drive-1", kind: "advance" },
      events: [{ type: "run_start", entrypoint: "drive" }],
      summary: null,
    },
  ]);
  assert.equal(drive[0]!.entrypoint, "drive");

  const loop = attemptsFromRunArtifacts([
    {
      runId: "loop-1",
      runJson: { run_id: "loop-1", kind: "advance" },
      events: [{ type: "run_start", entrypoint: "loop" }],
      summary: null,
    },
  ]);
  assert.equal(loop[0]!.entrypoint, "loop");

  const mergeQueue = attemptsFromRunArtifacts([
    {
      runId: "mq-1",
      runJson: { run_id: "mq-1", kind: "advance" },
      events: [{ type: "run_start", entrypoint: "merge-queue" }],
      summary: null,
    },
  ]);
  assert.equal(mergeQueue[0]!.entrypoint, "merge-queue");

  const ship = attemptsFromRunArtifacts([
    {
      runId: "ship-1",
      runJson: { run_id: "ship-1", kind: "advance" },
      events: [{ type: "run_start", entrypoint: "ship" }],
      summary: null,
    },
  ]);
  assert.equal(ship[0]!.entrypoint, "ship");

  const kindLoop = attemptsFromRunArtifacts([
    {
      runId: "kind-loop",
      runJson: { run_id: "kind-loop", kind: "loop" },
      events: [{ type: "run_start" }],
      summary: null,
    },
  ]);
  assert.equal(kindLoop[0]!.entrypoint, "loop");

  const kindAdvance = attemptsFromRunArtifacts([
    {
      runId: "adv",
      runJson: { run_id: "adv", kind: "advance" },
      events: [{ type: "run_start" }],
      summary: null,
    },
  ]);
  assert.equal(kindAdvance[0]!.entrypoint, null);
  assert.notEqual(kindAdvance[0]!.entrypoint, "single");

  const train = attemptsFromRunArtifacts([
    {
      runId: "tr",
      runJson: { run_id: "tr", kind: "train" },
      events: [],
      summary: null,
    },
  ]);
  assert.equal(train[0]!.entrypoint, "train");
});

test("attemptsFromRunArtifacts: start-event wins over kind and prefix (#1434)", () => {
  const attempts = attemptsFromRunArtifacts([
    {
      runId: "train-1",
      runJson: { run_id: "train-1", kind: "train" },
      events: [{ type: "run_start", entrypoint: "loop" }],
      summary: null,
    },
  ]);
  assert.equal(attempts[0]!.entrypoint, "loop");
});

test("attemptsFromRunArtifacts: kind wins over prefix (#1434)", () => {
  const attempts = attemptsFromRunArtifacts([
    {
      runId: "train-1",
      runJson: { run_id: "train-1", kind: "merge" },
      events: [{ type: "run_start" }],
      summary: null,
    },
  ]);
  assert.equal(attempts[0]!.entrypoint, "merge");
});

test("attemptsFromRunArtifacts: advance kind is not single and falls through to prefix (#1434)", () => {
  const prefixTrain = attemptsFromRunArtifacts([
    {
      runId: "train-abc",
      runJson: { run_id: "train-abc", kind: "advance" },
      events: [{ type: "run_start" }],
      summary: null,
    },
  ]);
  assert.equal(prefixTrain[0]!.entrypoint, "train");
  assert.notEqual(prefixTrain[0]!.entrypoint, "single");

  const noPrefix = attemptsFromRunArtifacts([
    {
      runId: "adv",
      runJson: { run_id: "adv", kind: "advance" },
      events: [{ type: "run_start" }],
      summary: null,
    },
  ]);
  assert.equal(noPrefix[0]!.entrypoint, null);
  assert.notEqual(noPrefix[0]!.entrypoint, "single");
});

test("mapPublicEntrypointFromRunId: single/merge/merge-queue prefixes (#1440)", () => {
  assert.equal(mapPublicEntrypointFromRunId("single-1"), "single");
  assert.equal(mapPublicEntrypointFromRunId("mq-1"), "merge-queue");
  assert.equal(mapPublicEntrypointFromRunId("merge-queue-1"), "merge-queue");
  assert.equal(mapPublicEntrypointFromRunId("merge-1"), "merge");
  assert.equal(mapPublicEntrypointFromRunId("merge-queue-repair-pr-42"), null);
});

test("attemptsFromRunArtifacts: merge-queue prefixes are checked before merge (#1434)", () => {
  const mq = attemptsFromRunArtifacts([
    { runId: "mq-1", runJson: { run_id: "mq-1" }, events: [], summary: null },
  ]);
  assert.equal(mq[0]!.entrypoint, "merge-queue");

  const mergeQueue = attemptsFromRunArtifacts([
    {
      runId: "merge-queue-1",
      runJson: { run_id: "merge-queue-1" },
      events: [],
      summary: null,
    },
  ]);
  assert.equal(mergeQueue[0]!.entrypoint, "merge-queue");
  assert.notEqual(mergeQueue[0]!.entrypoint, "merge");

  const merge = attemptsFromRunArtifacts([
    { runId: "merge-1", runJson: { run_id: "merge-1" }, events: [], summary: null },
  ]);
  assert.equal(merge[0]!.entrypoint, "merge");
});

test("attemptsFromRunArtifacts: numeric drive prefix maps when kind and start event are absent (#1434)", () => {
  const attempts = attemptsFromRunArtifacts([
    {
      runId: "1434-2026-09-04T18-24-39-123Z",
      runJson: { run_id: "1434-2026-09-04T18-24-39-123Z" },
      events: [],
      summary: null,
    },
  ]);
  assert.equal(attempts[0]!.entrypoint, "drive");
});

test("filterAttemptsBoundToCandidate: in-flight ship keeps missing SHA and missing release (#1434)", () => {
  const scored = "a".repeat(40);
  const kept = filterAttemptsBoundToCandidate(
    [
      { run_id: "unbound", logical_operation_id: "L", entrypoint: "train" },
      { run_id: "match", logical_operation_id: "L2", candidate_sha: scored, release_identity: "1.40.1" },
      { run_id: "other", logical_operation_id: "L3", candidate_sha: "b".repeat(40) },
      {
        run_id: "mismatch-release",
        logical_operation_id: "L4",
        candidate_sha: scored,
        release_identity: "1.39.0",
      },
    ],
    { candidate_sha: scored, release_identity: "1.40.1", inFlightShip: true },
  );
  assert.deepEqual(kept.map((a) => a.run_id), ["unbound", "match"]);
  assert.equal(kept[0]!.binding_provenance, "unbound_inflight");
  assert.equal(kept[1]!.binding_provenance, "bound");
});

test("aggregator: unbound inflight minted id with verified completion is observation-only (#1434)", () => {
  const scored = "a".repeat(40);
  const kept = filterAttemptsBoundToCandidate(
    [
      {
        run_id: "train-host",
        logical_operation_id: "lop-minted-unbound",
        entrypoint: "train",
        nested: false,
        postcondition_proof: true,
        terminal: "verified_success",
        identity_provenance: "minted",
      },
    ],
    { candidate_sha: scored, release_identity: "1.40.1", inFlightShip: true },
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.binding_provenance, "unbound_inflight");
  const report = aggregateUniqueOperationReliability({
    attempts: kept,
    manifest: {
      required_entrypoints: ["train"],
      required_lifecycle_classes: [],
      live_train_linkage_present: true,
      in_flight_ship: true,
    },
    candidate_sha: scored,
    release_identity: "1.40.1",
    in_flight_ship: true,
  });
  assert.ok(report.entrypoint_coverage.observed.includes("train"));
  assert.equal(report.clean_completion.numerator, 0);
  assert.equal(report.clean_completion.denominator, 0);
  assert.equal(report.ownerless_terminal.numerator, 0);
  assert.equal(report.exclusions.length, 0);
  assert.equal(report.integrity.missing_correlation, 0);
});

test("computeFrgEvidence: writes operation_reliability from durable fakes", () => {
  const evidence = computeFrgEvidence(packInput());
  assert.ok(evidence.operation_reliability);
  assert.equal(evidence.operation_reliability!.schema_version, 1);
  assert.equal(evidence.operation_reliability!.clean_completion.metric_kind, "unique_operation");
  assert.equal(evidence.pass, true);
});

test("missing correlation refuses release-eligible pass", () => {
  const evidence = computeFrgEvidence(
    packInput({
      unique_operations: [{ run_id: "no-id", process_exit_zero: true }],
      unique_operation_manifest: passingUniqueOperationManifest({ release_identity: "1.30.0" }),
    }),
  );
  assert.equal(evidence.pass, false);
  assert.ok(evidence.operation_reliability!.integrity.missing_correlation > 0);
  assert.equal(evidence.operation_reliability!.exclusions.length, 0);
  assert.throws(
    () =>
      validateReleaseEligibleFrgEvidence(JSON.parse(JSON.stringify(evidence)), "1.30.0", {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    /release-eligible|pass=false/i,
  );
});

test("false-human fixture refuses release-eligible pass and agrees with composition", () => {
  const evidence = computeFrgEvidence(
    packInput({
      false_human_authority_count: 1,
      unique_operations: [
        {
          run_id: "r1",
          logical_operation_id: "lop-L",
          nested: false,
          false_human: true,
          composition_false_human: true,
          entrypoint: "single",
        },
      ],
    }),
  );
  assert.ok(evidence.composition.false_human_authority_count > 0);
  assert.ok(evidence.operation_reliability!.false_human_projection.numerator > 0);
  assert.equal(evidence.pass, false);
});

test("ownerless terminal refuses release-eligible pass", () => {
  const evidence = computeFrgEvidence(
    packInput({
      unique_operations: [{ run_id: "r1", logical_operation_id: "lop-L", nested: false }],
      unique_operation_manifest: {
        ...passingUniqueOperationManifest({ release_identity: "1.30.0" }),
        required_entrypoints: [],
        required_lifecycle_classes: [],
      },
    }),
  );
  assert.ok(evidence.operation_reliability!.ownerless_terminal.numerator > 0);
  assert.equal(evidence.pass, false);
});

test("clean completion below 100% refuses pass", () => {
  const evidence = computeFrgEvidence(
    packInput({
      unique_operations: [
        {
          run_id: "r1",
          logical_operation_id: "lop-L",
          nested: false,
          postcondition_proof: true,
          manual_reinvocation: true,
          entrypoint: "single",
        },
      ],
      unique_operation_manifest: {
        ...passingUniqueOperationManifest({ release_identity: "1.30.0" }),
        required_entrypoints: ["single"],
        required_lifecycle_classes: [],
      },
    }),
  );
  assert.equal(evidence.pass, false);
  assert.notEqual(evidence.operation_reliability!.clean_completion.ratio, 1);
});

test("missing #1333 coverage is integrity failure not exclusion", () => {
  const evidence = computeFrgEvidence(
    packInput({
      unique_operations: passingUniqueOperationAttempts().map((a) => ({
        ...a,
        covered_lifecycle_classes: [],
      })),
      unique_operation_manifest: {
        ...passingUniqueOperationManifest({ release_identity: "1.30.0" }),
        covered_lifecycle_classes: [],
        required_lifecycle_classes: ["mechanical"],
      },
      matrix_covered_lifecycle_classes: [],
    }),
  );
  assert.ok(evidence.operation_reliability!.integrity.missing_required_coverage > 0);
  assert.equal(evidence.operation_reliability!.exclusions.length, 0);
  assert.equal(evidence.pass, false);
});

test("HMAC mutation of operation_reliability fails verification; public fingerprints stay intact", () => {
  const signed = computeFrgEvidence(packInput({ run_id: "frg-uop-mac" }));
  assert.equal(signed.pass, true);
  assert.equal(verifyFrgAttestation(signed, FRG_UNIT_TEST_ATTESTATION_KEY), true);
  const mutated = JSON.parse(JSON.stringify(signed));
  mutated.operation_reliability.clean_completion.numerator = 0;
  assert.equal(
    mutated.integrity.scoreboard_fingerprint,
    signed.integrity.scoreboard_fingerprint,
    "public scoreboard fingerprint must stay intact",
  );
  assert.equal(
    mutated.integrity.composition_fingerprint,
    signed.integrity.composition_fingerprint,
  );
  assert.equal(verifyFrgAttestation(mutated, FRG_UNIT_TEST_ATTESTATION_KEY), false);
  assert.throws(
    () =>
      validateReleaseEligibleFrgEvidence(mutated, "1.30.0", {
        attestationKey: FRG_UNIT_TEST_ATTESTATION_KEY,
      }),
    /attestation MAC|forged|does not match/i,
  );
});

test("offline scoreInput without live provenance stays non-release-eligible even with operation_reliability", () => {
  const evidence = computeFrgEvidence(
    packInput({
      loop_run_id: null,
      pack_id: null,
    }),
  );
  assert.ok(evidence.operation_reliability);
  assert.equal(evidence.pass, false);
  assert.equal(isReleaseEligibleFrgPass(evidence), false);
});

test("passing #1333 mechanical fixtures yield zero false-human and zero ownerless", () => {
  const evidence = computeFrgEvidence(packInput());
  assert.equal(evidence.operation_reliability!.false_human_projection.numerator, 0);
  assert.equal(evidence.operation_reliability!.ownerless_terminal.numerator, 0);
  assert.equal(uniqueOperationSloFailure(evidence.operation_reliability), null);
  assert.equal(evidence.pass, true);
});

test("empty candidate_sha is not release-eligible", () => {
  const evidence = computeFrgEvidence(packInput());
  assert.equal(isReleaseEligibleFrgPass(evidence), true);
  const emptySha = {
    ...evidence,
    operation_reliability: { ...evidence.operation_reliability!, candidate_sha: "" },
  };
  assert.equal(uniqueOperationSloFailure(emptySha.operation_reliability), "operation_reliability.candidate_sha is empty");
  assert.equal(isReleaseEligibleFrgPass(emptySha), false);
  const emptyRelease = {
    ...evidence,
    operation_reliability: { ...evidence.operation_reliability!, release_identity: "" },
  };
  assert.equal(
    uniqueOperationSloFailure(emptyRelease.operation_reliability),
    "operation_reliability.release_identity is empty",
  );
  assert.equal(isReleaseEligibleFrgPass(emptyRelease), false);
  const mismatchedRelease = {
    ...evidence,
    operation_reliability: {
      ...evidence.operation_reliability!,
      release_identity: "9.9.9",
    },
  };
  assert.equal(isReleaseEligibleFrgPass(mismatchedRelease), false);
  assert.match(
    uniqueOperationReleaseBindingFailure(mismatchedRelease.operation_reliability, {
      candidate_sha: null,
      release_identity: evidence.version,
    }) ?? "",
    /release_identity/,
  );
});

test("precomputed operation_reliability bound to a different candidate is not release-eligible", () => {
  const evidence = computeFrgEvidence(packInput());
  assert.equal(
    uniqueOperationReleaseBindingFailure(evidence.operation_reliability, {
      candidate_sha: "c".repeat(40),
      release_identity: evidence.version,
    }),
    "operation_reliability.candidate_sha does not match the scored candidate",
  );
  assert.equal(
    isReleaseEligibleFrgPass({
      ...evidence,
      operation_reliability: {
        ...evidence.operation_reliability!,
        candidate_sha: "d".repeat(40),
        release_identity: "0.0.1",
      },
    }),
    false,
  );
});

test("runFactoryGate without unique_operations cannot pass from absent durable evidence", async () => {
  const files = new Map<string, string>();
  const fs: FrgFsDeps = {
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
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      scoreInput: {
        version: "1.29.1",
        run_id: "frg-no-uop",
        loop_run_id: "loop-full-pass",
        pack_id: FRG_PACK_MANIFEST.pack_id,
        items: [
          { item_id: "1", state: "ready", ready_clean: true },
          { item_id: "2", state: "ready", ready_clean: true },
        ],
        scenario_overrides: frgRequiredObservationOverrides("pass"),
        composition_overrides: frgRequiredCompositionOverrides("pass"),
        attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
      },
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.evidence.pass, false);
  assert.ok(result.evidence.operation_reliability);
  assert.ok(result.evidence.operation_reliability!.integrity.missing_required_coverage > 0);
  assert.equal(isReleaseEligibleFrgPass(result.evidence), false);
});

test("aggregator: other-candidate attempts do not satisfy the scored candidate", () => {
  const staleSha = "b".repeat(40);
  const scoredSha = "a".repeat(40);
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "old-train",
        logical_operation_id: "lop-old",
        nested: false,
        postcondition_proof: true,
        entrypoint: "train",
        train_loop_linked: true,
        child_logical_operation_id: "lop-old",
        candidate_sha: staleSha,
        covered_lifecycle_classes: ["mechanical", "workflow", "infrastructure", "authentication", "unknown"],
      },
    ],
    manifest: {
      required_entrypoints: ["train"],
      required_lifecycle_classes: ["mechanical"],
      candidate_sha: scoredSha,
      live_train_linkage_present: false,
    },
    candidate_sha: scoredSha,
  });
  assert.equal(report.operations.length, 0);
  assert.equal(report.clean_completion.numerator, 0);
  assert.ok(report.integrity.missing_required_coverage > 0);
  assert.equal(report.candidate_sha, scoredSha);
});

test("filterAttemptsBoundToCandidate: drops unbound and other-candidate artifacts", () => {
  const scored = "a".repeat(40);
  const kept = filterAttemptsBoundToCandidate(
    [
      { run_id: "match", logical_operation_id: "L", candidate_sha: scored, postcondition_proof: true },
      { run_id: "stale", logical_operation_id: "L2", candidate_sha: "b".repeat(40), postcondition_proof: true },
      { run_id: "unbound", logical_operation_id: "L3", postcondition_proof: true },
    ],
    { candidate_sha: scored },
  );
  assert.deepEqual(kept.map((a) => a.run_id), ["match"]);
});

test("filterAttemptsBoundToCandidate: drops missing and mismatched release identity when scored", () => {
  const scored = "a".repeat(40);
  const kept = filterAttemptsBoundToCandidate(
    [
      {
        run_id: "match",
        logical_operation_id: "L",
        candidate_sha: scored,
        release_identity: "1.40.1",
        postcondition_proof: true,
      },
      {
        run_id: "mismatch",
        logical_operation_id: "L2",
        candidate_sha: scored,
        release_identity: "1.39.0",
        postcondition_proof: true,
      },
      {
        run_id: "absent",
        logical_operation_id: "L3",
        candidate_sha: scored,
        postcondition_proof: true,
      },
    ],
    { candidate_sha: scored, release_identity: "1.40.1" },
  );
  assert.deepEqual(kept.map((a) => a.run_id), ["match"]);
});

test("attemptsFromRunArtifacts: extracts candidate binding into evidence refs", () => {
  const sha = "c".repeat(40);
  const attempts = attemptsFromRunArtifacts([
    {
      runId: "bound",
      runJson: { run_id: "bound", logical_operation_id: "L", candidate_sha: sha, kind: "single" },
      events: [{ type: "run_start", logical_operation_id: "L", entrypoint: "single" }],
      summary: { verified_completion: true, logical_operation_id: "L", candidate_sha: sha },
    },
  ]);
  assert.equal(attempts[0]!.candidate_sha, sha);
  assert.ok(attempts[0]!.evidence_refs?.includes(`candidate:${sha}`));
});

test("aggregator: later verified attempt does not erase an unresolved ownerless terminal", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      { run_id: "crash", logical_operation_id: "lop-L", nested: false, entrypoint: "single" },
      {
        run_id: "retry",
        logical_operation_id: "lop-L",
        nested: false,
        postcondition_proof: true,
        entrypoint: "single",
      },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.operations[0]!.terminal, "ownerless_terminal");
  assert.equal(report.ownerless_terminal.numerator, 1);
  assert.equal(report.clean_completion.numerator, 0);
});

test("aggregator: ownerless then durable cooling then verified is recovered success", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      { run_id: "crash", logical_operation_id: "lop-L", nested: false, entrypoint: "single" },
      {
        run_id: "cool",
        logical_operation_id: "lop-L",
        nested: false,
        terminal: "cooling_recovery",
        entrypoint: "single",
      },
      {
        run_id: "retry",
        logical_operation_id: "lop-L",
        nested: false,
        postcondition_proof: true,
        entrypoint: "single",
      },
    ],
    manifest: { required_entrypoints: [], required_lifecycle_classes: [], live_train_linkage_present: true },
  });
  assert.equal(report.operations[0]!.terminal, "verified_success");
  assert.equal(report.ownerless_terminal.numerator, 0);
  assert.equal(report.clean_completion.numerator, 1);
});

test("attemptsFromRunArtifacts: train_loop_linked without followable child is not live linkage", () => {
  const parentOnly = attemptsFromRunArtifacts([
    {
      runId: "train-1",
      runJson: { run_id: "train-1", kind: "train", logical_operation_id: "lop-train" },
      events: [
        { type: "run_start", entrypoint: "train", logical_operation_id: "lop-train" },
        { type: "train_loop_linked", logical_operation_id: "lop-train" },
      ],
      summary: { verified_completion: true, logical_operation_id: "lop-train" },
    },
  ]);
  assert.equal(parentOnly[0]!.train_loop_linked, false);
  assert.equal(parentOnly[0]!.child_logical_operation_id, null);

  const missingChild = attemptsFromRunArtifacts([
    {
      runId: "train-2",
      runJson: { run_id: "train-2", kind: "train", logical_operation_id: "lop-train" },
      events: [
        {
          type: "train_loop_linked",
          logical_operation_id: "lop-train",
          loop_run_id: "loop-missing",
          events: "/state/runs/loop-missing/events.jsonl",
        },
      ],
      summary: null,
    },
  ]);
  assert.equal(missingChild[0]!.train_loop_linked, false);

  const followable = attemptsFromRunArtifacts([
    {
      runId: "train-3",
      runJson: { run_id: "train-3", kind: "train", logical_operation_id: "lop-train" },
      events: [
        {
          type: "train_loop_linked",
          logical_operation_id: "lop-train",
          loop_run_id: "loop-child",
          events: "/state/runs/loop-child/events.jsonl",
        },
      ],
      summary: { verified_completion: true, logical_operation_id: "lop-train" },
    },
    {
      runId: "loop-child",
      runJson: { run_id: "loop-child", kind: "loop", logical_operation_id: "lop-train" },
      events: [{ type: "run_start", entrypoint: "loop", logical_operation_id: "lop-train" }],
      summary: { logical_operation_id: "lop-train" },
      eventsFilePath: "/state/runs/loop-child/events.jsonl",
    },
  ]);
  assert.equal(followable[0]!.train_loop_linked, true);
  assert.equal(followable[0]!.child_logical_operation_id, "lop-train");
  assert.equal(followable[0]!.child_run_id, "loop-child");

  const report = aggregateUniqueOperationReliability({
    attempts: parentOnly,
    manifest: { required_entrypoints: ["train"], required_lifecycle_classes: [], live_train_linkage_present: false },
  });
  assert.ok(report.integrity.missing_required_coverage > 0);
});

test("attemptsFromRunArtifacts: child run_id fallback mismatch still counts as live train-link (#1440)", () => {
  const attempts = attemptsFromRunArtifacts([
    {
      runId: "train-T",
      runJson: { run_id: "train-T", kind: "train", logical_operation_id: "T" },
      events: [
        { type: "run_start", entrypoint: "train", logical_operation_id: "T" },
        {
          type: "train_loop_linked",
          logical_operation_id: "T",
          loop_run_id: "loop-1",
          events: "/host-state/runs/loop-1/events.jsonl",
        },
      ],
      summary: null,
    },
    {
      runId: "loop-1",
      runJson: { run_id: "loop-1", kind: "loop" },
      events: [{ type: "run_start", entrypoint: "loop" }],
      summary: null,
      eventsFilePath: "/host-state/runs/loop-1/events.jsonl",
    },
  ]);
  const train = attempts.find((a) => a.run_id === "train-T");
  assert.equal(train!.train_loop_linked, true);
  assert.equal(train!.child_logical_operation_id, "T");
  assert.equal(train!.child_run_id, "loop-1");
  assert.equal(train!.identity_provenance, "minted");
  const child = attempts.find((a) => a.run_id === "loop-1");
  assert.equal(child!.identity_provenance, "run_id_fallback");
  assert.equal(child!.logical_operation_id, "loop-1");
  const report = aggregateUniqueOperationReliability({
    attempts,
    manifest: {
      required_entrypoints: ["train", "loop"],
      required_lifecycle_classes: [],
      live_train_linkage_present: false,
    },
  });
  assert.equal(report.integrity.contradictory_correlation, 0);
  assert.equal(report.entrypoint_coverage.missing.includes("train"), false);
  assert.ok(report.integrity.missing_required_coverage === 0 || !report.entrypoint_coverage.missing.includes("train"));
});

test("attemptsFromRunArtifacts: relative train_loop_linked events path is not followable (#1440)", () => {
  const attempts = attemptsFromRunArtifacts([
    {
      runId: "train-rel",
      runJson: { run_id: "train-rel", kind: "train", logical_operation_id: "T" },
      events: [
        {
          type: "train_loop_linked",
          logical_operation_id: "T",
          loop_run_id: "loop-1",
          events: "runs/loop-1/events.jsonl",
        },
      ],
      summary: null,
    },
    {
      runId: "loop-1",
      runJson: { run_id: "loop-1" },
      events: [{ type: "run_start", entrypoint: "loop" }],
      summary: null,
    },
  ]);
  assert.equal(attempts[0]!.train_loop_linked, false);
});

test("attemptsFromRunArtifacts: unrelated in-root events path is not followable (#1440)", () => {
  const childPath = "/host-state/runs/loop-1/events.jsonl";
  const unrelated = "/host-state/runs/other/events.jsonl";
  const mismatched = attemptsFromRunArtifacts([
    {
      runId: "train-T",
      runJson: { run_id: "train-T", kind: "train", logical_operation_id: "T" },
      events: [
        {
          type: "train_loop_linked",
          logical_operation_id: "T",
          loop_run_id: "loop-1",
          events: unrelated,
        },
      ],
      summary: null,
    },
    {
      runId: "loop-1",
      runJson: { run_id: "loop-1", kind: "loop", logical_operation_id: "T" },
      events: [{ type: "run_start", entrypoint: "loop", logical_operation_id: "T" }],
      summary: null,
      eventsFilePath: childPath,
    },
  ]);
  assert.equal(mismatched[0]!.train_loop_linked, false);

  const missingPath = attemptsFromRunArtifacts([
    {
      runId: "train-T2",
      runJson: { run_id: "train-T2", kind: "train", logical_operation_id: "T" },
      events: [
        {
          type: "train_loop_linked",
          logical_operation_id: "T",
          loop_run_id: "loop-1",
          events: childPath,
        },
      ],
      summary: null,
    },
    {
      runId: "loop-1",
      runJson: { run_id: "loop-1", kind: "loop", logical_operation_id: "T" },
      events: [{ type: "run_start", entrypoint: "loop", logical_operation_id: "T" }],
      summary: null,
    },
  ]);
  assert.equal(missingPath[0]!.train_loop_linked, false);
});

test("attemptsFromRunArtifacts: duplicate run id at a different path does not hide the event-referenced child (#1440)", () => {
  const stalePath = "/host-state/runs/loop-1/events.jsonl";
  const linkedPath = "/control-repo/.agent-pipeline/runs/loop-1/events.jsonl";
  const train = {
    runId: "train-T",
    runJson: { run_id: "train-T", kind: "train", logical_operation_id: "T" },
    events: [
      { type: "run_start", entrypoint: "train", logical_operation_id: "T" },
      {
        type: "train_loop_linked",
        logical_operation_id: "T",
        loop_run_id: "loop-1",
        events: linkedPath,
      },
    ],
    summary: null,
  };
  const stale = {
    runId: "loop-1",
    runJson: { run_id: "loop-1", kind: "loop" },
    events: [{ type: "run_start", entrypoint: "loop" }],
    summary: null,
    eventsFilePath: stalePath,
  };
  const linked = {
    runId: "loop-1",
    runJson: { run_id: "loop-1", kind: "loop" },
    events: [{ type: "run_start", entrypoint: "loop" }],
    summary: null,
    eventsFilePath: linkedPath,
  };
  for (const runs of [
    [train, stale, linked],
    [train, linked, stale],
  ]) {
    const attempts = attemptsFromRunArtifacts(runs);
    const found = attempts.find((a) => a.run_id === "train-T");
    assert.equal(found!.train_loop_linked, true);
    assert.equal(found!.child_run_id, "loop-1");
    assert.equal(found!.child_events_path, linkedPath);
  }
});

test("attemptsFromRunArtifacts: parent logical id is inherited when event and child omit a minted id (#1446)", () => {
  const childPath = "/host-state/runs/loop-1/events.jsonl";
  const attempts = attemptsFromRunArtifacts([
    {
      runId: "train-T",
      runJson: { run_id: "train-T", kind: "train", logical_operation_id: "T" },
      events: [
        { type: "run_start", entrypoint: "train", logical_operation_id: "T" },
        {
          type: "train_loop_linked",
          loop_run_id: "loop-1",
          events: childPath,
        },
      ],
      summary: null,
    },
    {
      runId: "loop-1",
      runJson: { run_id: "loop-1", kind: "loop" },
      events: [{ type: "run_start", entrypoint: "loop" }],
      summary: null,
      eventsFilePath: childPath,
    },
  ]);
  const train = attempts.find((a) => a.run_id === "train-T");
  assert.equal(train!.train_loop_linked, true);
  assert.equal(train!.child_logical_operation_id, "T");
  assert.equal(train!.child_run_id, "loop-1");
  const report = aggregateUniqueOperationReliability({
    attempts,
    manifest: {
      required_entrypoints: ["train"],
      required_lifecycle_classes: [],
      live_train_linkage_present: false,
    },
  });
  const scored = report.operations.find((o) => o.entrypoints.includes("train"));
  assert.equal(scored!.child_logical_operation_id, "T");
  assert.equal(report.integrity.missing_required_coverage, 0);
});

test("aggregateUniqueOperationReliability: train without inherited child logical id fails #1301 (#1446)", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: [
      {
        run_id: "train-T",
        logical_operation_id: "T",
        entrypoint: "train",
        train_loop_linked: true,
        child_logical_operation_id: null,
      },
    ],
    manifest: {
      required_entrypoints: ["train"],
      required_lifecycle_classes: [],
      live_train_linkage_present: false,
    },
  });
  const scored = report.operations.find((o) => o.entrypoints.includes("train"));
  assert.equal(scored!.child_logical_operation_id, undefined);
  assert.ok(report.integrity.missing_required_coverage > 0);
});

test("attemptsFromRunArtifacts: child minted logical id without event logical id is followable (#1440)", () => {
  const childPath = "/host-state/runs/loop-1/events.jsonl";
  const attempts = attemptsFromRunArtifacts([
    {
      runId: "train-T",
      runJson: { run_id: "train-T", kind: "train", logical_operation_id: "T" },
      events: [
        { type: "run_start", entrypoint: "train", logical_operation_id: "T" },
        {
          type: "train_loop_linked",
          loop_run_id: "loop-1",
          events: childPath,
        },
      ],
      summary: null,
    },
    {
      runId: "loop-1",
      runJson: { run_id: "loop-1", kind: "loop", logical_operation_id: "C" },
      events: [{ type: "run_start", entrypoint: "loop", logical_operation_id: "C" }],
      summary: { logical_operation_id: "C" },
      eventsFilePath: childPath,
    },
  ]);
  const train = attempts.find((a) => a.run_id === "train-T");
  assert.equal(train!.train_loop_linked, true);
  assert.equal(train!.child_logical_operation_id, "C");
  assert.equal(train!.child_run_id, "loop-1");
  const report = aggregateUniqueOperationReliability({
    attempts,
    manifest: {
      required_entrypoints: ["train", "loop"],
      required_lifecycle_classes: [],
      live_train_linkage_present: false,
    },
  });
  assert.equal(report.integrity.contradictory_correlation, 0);
  assert.equal(report.entrypoint_coverage.missing.includes("train"), false);
  assert.equal(report.integrity.missing_required_coverage, 0);
});

test("attemptsFromRunArtifacts: single prefix maps when kind and start event are absent (#1440)", () => {
  const attempts = attemptsFromRunArtifacts([
    { runId: "single-1", runJson: { run_id: "single-1" }, events: [], summary: null },
  ]);
  assert.equal(attempts[0]!.entrypoint, "single");
});

test("computeFrgEvidence: caller-supplied operation_reliability is not durable proof", () => {
  const honest = computeFrgEvidence(packInput());
  assert.equal(honest.pass, true);
  const spoofed = computeFrgEvidence(
    packInput({
      unique_operations: [],
      operation_reliability: honest.operation_reliability,
    }),
  );
  assert.equal(spoofed.pass, false);
  assert.ok(spoofed.operation_reliability!.integrity.missing_required_coverage > 0);
  assert.notEqual(
    spoofed.operation_reliability!.clean_completion.numerator,
    honest.operation_reliability!.clean_completion.numerator,
  );
  const fixtureOnly = computeFrgEvidence(
    packInput({
      unique_operations: [],
      test_only_operation_reliability_fixture: honest.operation_reliability,
    }),
  );
  assert.equal(fixtureOnly.pass, false);
  assert.equal(isReleaseEligibleFrgPass(fixtureOnly), false);
});

test("runFactoryGate: stale-candidate run-store artifacts cannot pass the current candidate", async () => {
  const files = new Map<string, string>();
  const staleSha = "b".repeat(40);
  const scoredSha = "a".repeat(40);
  const runRoot = "/repo/.agent-pipeline/runs";
  for (const entrypoint of ["drive", "single", "loop", "train", "merge", "merge-queue", "ship"]) {
    const dir = `${runRoot}/old-${entrypoint}`;
    files.set(
      `${dir}/run.json`,
      JSON.stringify({
        run_id: `old-${entrypoint}`,
        kind: entrypoint,
        logical_operation_id: "lop-stale",
        candidate_sha: staleSha,
      }),
    );
    const events = [
      { type: "run_start", entrypoint, logical_operation_id: "lop-stale" },
      { type: "verified_completion", exact_candidate_proof: true },
    ];
    if (entrypoint === "train") {
      events.push({
        type: "train_loop_linked",
        logical_operation_id: "lop-stale",
        loop_run_id: "old-loop",
        events: `${runRoot}/old-loop/events.jsonl`,
      });
    }
    files.set(`${dir}/events.jsonl`, events.map((e) => JSON.stringify(e)).join("\n"));
    files.set(
      `${dir}/summary.json`,
      JSON.stringify({
        verified_completion: true,
        logical_operation_id: "lop-stale",
        candidate_sha: staleSha,
      }),
    );
  }
  files.set(
    `${runRoot}/old-loop/run.json`,
    JSON.stringify({
      run_id: "old-loop",
      kind: "loop",
      logical_operation_id: "lop-stale",
      candidate_sha: staleSha,
    }),
  );
  files.set(
    `${runRoot}/old-loop/events.jsonl`,
    JSON.stringify({ type: "run_start", entrypoint: "loop", logical_operation_id: "lop-stale" }),
  );
  files.set(
    `${runRoot}/old-loop/loop-run-handoff.json`,
    JSON.stringify({
      kind: "loop_run_handoff",
      run_id: "old-loop",
      events: `${runRoot}/old-loop/events.jsonl`,
      logical_operation_id: "lop-stale",
      candidate_sha: staleSha,
    }),
  );
  const fs: FrgFsDeps = {
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
    async readdir(p) {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const name = key.slice(prefix.length).split("/")[0];
        if (name) names.add(name);
      }
      return [...names].map((name) => ({ name, isDirectory: () => true }));
    },
  };
  const result = await runFactoryGate(
    {
      version: "1.29.1",
      repoDir: "/repo",
      scoreInput: {
        version: "1.29.1",
        run_id: "frg-stale-mix",
        loop_run_id: "loop-full-pass",
        pack_id: FRG_PACK_MANIFEST.pack_id,
        items: [
          { item_id: "1", state: "ready", ready_clean: true },
          { item_id: "2", state: "ready", ready_clean: true },
        ],
        scenario_overrides: frgRequiredObservationOverrides("pass"),
        composition_overrides: frgRequiredCompositionOverrides("pass"),
        attestation_key: FRG_UNIT_TEST_ATTESTATION_KEY,
        unique_operation_manifest: passingUniqueOperationManifest({
          release_identity: "1.29.1",
          candidate_sha: scoredSha,
        }),
      },
      stdout: () => {},
      stderr: () => {},
    },
    fs,
  );
  assert.equal(result.evidence.pass, false);
  assert.equal(result.evidence.operation_reliability!.operations.length, 0);
  assert.ok(result.evidence.operation_reliability!.integrity.missing_required_coverage > 0);
  assert.equal(isReleaseEligibleFrgPass(result.evidence), false);
});

function attemptsWithoutShip(sha = "a".repeat(40)): ReturnType<typeof passingUniqueOperationAttempts> {
  return passingUniqueOperationAttempts()
    .filter((a) => a.entrypoint !== "ship")
    .map((a) => ({ ...a, candidate_sha: sha }));
}

test("aggregator: in-flight ship is not missing coverage and is not an exclusion (#1428)", () => {
  assert.ok(REQUIRED_PUBLIC_ENTRYPOINTS.includes("ship"));
  const report = aggregateUniqueOperationReliability({
    attempts: attemptsWithoutShip(),
    manifest: {
      ...passingUniqueOperationManifest({ release_identity: "1.40.1" }),
      in_flight_ship: true,
    },
    candidate_sha: "a".repeat(40),
    release_identity: "1.40.1",
    matrix_covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
    in_flight_ship: true,
  });
  assert.ok(!report.entrypoint_coverage.missing.includes("ship"));
  assert.ok(report.entrypoint_coverage.required.includes("ship"));
  assert.ok(!report.entrypoint_coverage.observed.includes("ship"));
  assert.equal(report.exclusions.length, 0);
  assert.equal(report.operations.some((op) => op.entrypoints.includes("ship")), false);
  assert.equal(uniqueOperationSloFailure(report), null);
});

test("aggregator: completed prior ship is observed coverage, not in-flight success (#1428)", () => {
  const priorShip = {
    run_id: "run-prior-ship",
    logical_operation_id: "lop-prior-ship",
    parent_logical_operation_id: "lop-prior-ship",
    entrypoint: "ship",
    nested: false,
    postcondition_proof: true,
    terminal: "verified_success" as const,
    candidate_sha: "a".repeat(40),
  };
  const report = aggregateUniqueOperationReliability({
    attempts: [...attemptsWithoutShip(), priorShip],
    manifest: {
      ...passingUniqueOperationManifest({ release_identity: "1.40.1" }),
      in_flight_ship: true,
    },
    candidate_sha: "a".repeat(40),
    release_identity: "1.40.1",
    matrix_covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
    in_flight_ship: true,
  });
  assert.ok(report.entrypoint_coverage.observed.includes("ship"));
  assert.ok(!report.entrypoint_coverage.missing.includes("ship"));
  const shipOps = report.operations.filter((op) => op.entrypoints.includes("ship"));
  assert.equal(shipOps.length, 1);
  assert.equal(shipOps[0]!.logical_operation_id, "lop-prior-ship");
  assert.notEqual(shipOps[0]!.logical_operation_id, "lop-frg-required-coverage");
});

test("aggregator: missing train still increments coverage during in-flight ship FRG (#1428)", () => {
  const report = aggregateUniqueOperationReliability({
    attempts: attemptsWithoutShip().filter((a) => a.entrypoint !== "train"),
    manifest: {
      ...passingUniqueOperationManifest({ release_identity: "1.40.1" }),
      in_flight_ship: true,
    },
    candidate_sha: "a".repeat(40),
    release_identity: "1.40.1",
    matrix_covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
    in_flight_ship: true,
  });
  assert.ok(report.entrypoint_coverage.missing.includes("train"));
  assert.ok(!report.entrypoint_coverage.missing.includes("ship"));
  assert.ok(report.integrity.missing_required_coverage > 0);
  assert.equal(report.exclusions.length, 0);
  assert.match(uniqueOperationSloFailure(report) ?? "", /missing required coverage/);
});
