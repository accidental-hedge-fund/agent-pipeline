import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FAULT_RECOVERY_MATRIX,
  FAULT_RECOVERY_MATRIX_VERSION,
  MATRIX_FAULT_STATES,
  bindExecutedMatrixRowsForCandidate,
  matrixCellKey,
  requiredMatrixOperations,
  type ExecutedMatrixRow,
  type AdapterObservation,
  type MatrixFaultState,
} from "./fault-recovery-matrix.ts";
import { observeFaultThroughRecoverySupervisor } from "./qualification-recovery-observer.ts";

export const INSTALLED_CLI_QUALIFICATION_SCHEMA =
  "pipeline/installed-cli-qualification@1" as const;
export const INSTALLED_CLI_PROBE_SCHEMA = "pipeline/installed-cli-qualification-probe@1" as const;

const EXACT_SHA = /^[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const DENIED_CREDENTIAL_ENV = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "BUZZ_CREDENTIALS_FILE",
  "AGENT_PIPELINE_FRG_ATTESTATION_KEY",
  "AGENT_PIPELINE_FRG_ATTESTATION_KEY_FILE",
] as const;
const PROCESS_FAULTS = new Set<MatrixFaultState>([
  "exception",
  "rejection",
  "nonzero_exit",
  "signal",
  "timeout",
  "malformed_or_contradictory_output",
]);
const TEST_SUITE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface InstalledCliProbeFixture {
  schema: typeof INSTALLED_CLI_PROBE_SCHEMA;
  nonce: string;
  operation: string;
  fault_states: MatrixFaultState[];
  mode: "process" | "recovery";
}

export interface InstalledCliProcessProof {
  operation: string;
  fault_states: MatrixFaultState[];
  cell_keys: string[];
  argv: string[];
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  stdout_sha256: string;
  stdout_json: boolean | null;
  observations?: AdapterObservation[];
}

export interface InstalledCliQualificationArtifact {
  schema: typeof INSTALLED_CLI_QUALIFICATION_SCHEMA;
  candidate_sha: string;
  launcher: string;
  matrix_version: number;
  generated_at: string;
  rows: ExecutedMatrixRow[];
  proofs: InstalledCliProcessProof[];
  digest_sha256: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

export function installedCliQualificationArtifactDigest(
  value: Omit<InstalledCliQualificationArtifact, "digest_sha256">,
): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function installedCells() {
  const seen = new Set<string>();
  return FAULT_RECOVERY_MATRIX.filter(
    (row) => row.layer === "installed_cli" && !row.not_applicable && !row.ship_phase,
  ).filter((row) => {
    const key = matrixCellKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function qualificationCells() {
  const seen = new Set<string>();
  const applicable = FAULT_RECOVERY_MATRIX.filter((row) => !row.not_applicable && !row.ship_phase);
  const selected: typeof applicable = [];
  for (const layer of ["adapter_contract", "installed_cli", "host_conformance"] as const) {
    for (const lifecycle of ["mechanical", "workflow", "infrastructure", "authentication", "unknown"] as const) {
      const preferredFault = {
        mechanical: "nonzero_exit",
        workflow: "malformed_or_contradictory_output",
        infrastructure: "unavailable_harness",
        authentication: "authentication",
        unknown: "unseen_provider_error_shape",
      }[lifecycle];
      const cell = applicable.find(
        (candidate) =>
          candidate.layer === layer &&
          candidate.lifecycle_class === lifecycle &&
          candidate.fault_state === preferredFault &&
          candidate.operation === "drive" &&
          (layer !== "host_conformance" || candidate.host === "direct_cli"),
      );
      if (!cell) continue;
      const key = matrixCellKey(cell);
      if (!seen.has(key)) {
        seen.add(key);
        selected.push(cell);
      }
    }
  }
  return selected;
}

function parseProbeFixture(value: unknown): InstalledCliProbeFixture | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (
    o.schema !== INSTALLED_CLI_PROBE_SCHEMA ||
    typeof o.nonce !== "string" ||
    !NONCE.test(o.nonce) ||
    typeof o.operation !== "string" ||
    !o.operation ||
    !Array.isArray(o.fault_states) ||
    o.fault_states.length === 0 ||
    o.fault_states.some(
      (fault) =>
        typeof fault !== "string" ||
        !(MATRIX_FAULT_STATES as readonly string[]).includes(fault),
    ) ||
    (o.mode !== "process" && o.mode !== "recovery")
  ) {
    return null;
  }
  const faultStates = o.fault_states as MatrixFaultState[];
  if (new Set(faultStates).size !== faultStates.length) return null;
  if (!installedCells().some((row) => row.operation === o.operation)) return null;
  return {
    schema: INSTALLED_CLI_PROBE_SCHEMA,
    nonce: o.nonce,
    operation: o.operation,
    fault_states: faultStates,
    mode: o.mode,
  };
}

/** Closed child-side probe. It is dispatched before config, network, git, or admission. */
export async function runInstalledCliQualificationProbe(
  fixturePath: string,
  routedOperation: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<never> {
  if (!path.isAbsolute(fixturePath)) {
    process.stderr.write("pipeline qualification probe: fixture path must be absolute\n");
    process.exit(64);
  }
  const credential = DENIED_CREDENTIAL_ENV.find((name) => String(env[name] ?? "").trim());
  if (credential) {
    process.stderr.write(`pipeline qualification probe: refuses credential environment ${credential}\n`);
    process.exit(64);
  }
  let fixture: InstalledCliProbeFixture | null = null;
  try {
    fixture = parseProbeFixture(JSON.parse(readFileSync(fixturePath, "utf8")));
  } catch {
    fixture = null;
  }
  if (!fixture || fixture.operation !== routedOperation) {
    process.stderr.write("pipeline qualification probe: malformed or route-mismatched fixture\n");
    process.exit(64);
  }
  const [fault] = fixture.fault_states;
  if (fixture.mode === "process" && fixture.fault_states.length === 1 && PROCESS_FAULTS.has(fault!)) {
    if (fault === "exception") throw new Error("qualification injected exception");
    if (fault === "rejection") {
      await Promise.reject(new Error("qualification injected rejection"));
    }
    if (fault === "nonzero_exit") process.exit(23);
    if (fault === "signal") {
      process.kill(process.pid, "SIGTERM");
      return undefined as never;
    }
    if (fault === "timeout") {
      setInterval(() => undefined, 1000);
      return undefined as never;
    }
    process.stdout.write("{malformed qualification output\n");
    process.exit(0);
  }
  if (fixture.mode === "process") {
    process.stderr.write("pipeline qualification probe: process mode requires one process fault\n");
    process.exit(64);
  }
  const observations: AdapterObservation[] = [];
  for (const faultState of fixture.fault_states) {
    observations.push(await observeFaultThroughRecoverySupervisor(faultState));
  }
  process.stdout.write(
    `${JSON.stringify({
      schema: INSTALLED_CLI_PROBE_SCHEMA,
      nonce: fixture.nonce,
      operation: fixture.operation,
      observations,
    })}\n`,
  );
  process.exit(0);
}

function routeArgs(operation: string, fixturePath: string): string[] {
  if (operation === "drive") return ["1", "--qualification-probe", fixturePath];
  return [operation, "--qualification-probe", fixturePath];
}

function proofFor(
  operation: string,
  faults: MatrixFaultState[],
  cellKeys: string[],
  argv: string[],
  result: SpawnSyncReturns<string>,
  observations?: AdapterObservation[],
): InstalledCliProcessProof {
  let stdoutJson: boolean | null = null;
  if ((result.stdout ?? "").trim()) {
    try {
      JSON.parse(result.stdout);
      stdoutJson = true;
    } catch {
      stdoutJson = false;
    }
  }
  return {
    operation,
    fault_states: [...faults],
    cell_keys: [...cellKeys],
    argv,
    exit_code: result.status,
    signal: result.signal,
    timed_out: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    stdout_sha256: `sha256:${sha256(result.stdout ?? "")}`,
    stdout_json: stdoutJson,
    ...(observations ? { observations } : {}),
  };
}

function safeObservationForCell(
  observation: AdapterObservation | undefined,
  cell: ReturnType<typeof qualificationCells>[number],
): boolean {
  return (
    observation != null &&
    observation.fault_state === cell.fault_state &&
    observation.lifecycle_class === cell.lifecycle_class &&
    observation.unique_operation_terminal === cell.expected_terminal &&
    observation.declared_run_terminal === false &&
    observation.false_human === false &&
    observation.ownerless_terminal === false &&
    observation.supervisor_stop === false &&
    observation.unauthorized_mutation === false &&
    observation.side_effect_replayed === false &&
    Number.isSafeInteger(observation.mutation_count) &&
    observation.mutation_count >= 0
  );
}

function directProofMatchesFault(
  proof: InstalledCliProcessProof,
  fault: MatrixFaultState,
): boolean {
  if (proof.observations) return false;
  if (fault === "exception" || fault === "rejection" || fault === "nonzero_exit") {
    return proof.exit_code !== null && proof.exit_code !== 0 && proof.signal === null;
  }
  if (fault === "signal") return proof.signal === "SIGTERM";
  if (fault === "timeout") return proof.timed_out;
  if (fault === "malformed_or_contradictory_output") {
    return proof.exit_code === 0 && proof.signal === null && proof.stdout_json === false;
  }
  return true;
}

function sameFaultSet(actual: MatrixFaultState[], expected: readonly MatrixFaultState[]): boolean {
  return actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((fault) => actual.includes(fault));
}

function sameStringSet(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value));
}

function processFailureSummary(result: SpawnSyncReturns<string>): string {
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code ?? "none";
  const tail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .trim()
    .slice(-2_000)
    .replace(/\s+/g, " ");
  return `status=${result.status ?? "null"},signal=${result.signal ?? "none"},error=${errorCode}` +
    (tail ? `,tail=${tail}` : "");
}

function stagedLauncherFromProofs(proofs: InstalledCliProcessProof[]): string | null {
  const launchers = new Set(
    proofs
      .filter((proof) => requiredMatrixOperations().includes(proof.operation))
      .map((proof) => proof.argv[0]),
  );
  if (launchers.size !== 1) return null;
  const launcher = [...launchers][0];
  if (
    typeof launcher !== "string" ||
    !path.isAbsolute(launcher) ||
    path.basename(launcher) !== "pipeline-launcher.mjs" ||
    path.basename(path.dirname(launcher)) !== "scripts" ||
    path.basename(path.dirname(path.dirname(launcher))) !== "package"
  ) return null;
  return launcher;
}

function routeProofArgvMatches(
  proof: InstalledCliProcessProof,
  operation: string,
  stagedLauncher: string,
): boolean {
  if (proof.argv.length !== 4 || proof.argv[0] !== stagedLauncher) return false;
  if (proof.argv[1] !== (operation === "drive" ? "1" : operation)) return false;
  if (proof.argv[2] !== "--qualification-probe" || !path.isAbsolute(proof.argv[3]!)) return false;
  const packageRoot = path.dirname(path.dirname(stagedLauncher));
  const qualificationRoot = path.dirname(packageRoot);
  if (path.dirname(proof.argv[3]!) !== qualificationRoot) return false;
  const safeOperation = operation.replace(/[^a-z0-9-]/gi, "_");
  return new RegExp(`^${safeOperation}-[0-9a-f]{32}\\.json$`).test(path.basename(proof.argv[3]!));
}

function suiteProofArgvMatches(
  proof: InstalledCliProcessProof,
  stagedLauncher: string,
  expectedTestNames: readonly string[],
): boolean {
  if (
    proof.argv.length !== expectedTestNames.length + 2 ||
    proof.argv[0] !== "--test" ||
    proof.argv[1] !== "--experimental-strip-types"
  ) return false;
  const expectedTestRoot = path.join(
    path.dirname(path.dirname(stagedLauncher)),
    "core",
    "test",
  );
  const actualNames = proof.argv.slice(2).map((testPath) => {
    if (!path.isAbsolute(testPath) || path.dirname(testPath) !== expectedTestRoot) return null;
    return path.basename(testPath);
  });
  return actualNames.every((name): name is string => name !== null) &&
    actualNames.every((name, index) => name === expectedTestNames[index]);
}

function detachedStartupProofArgvMatches(
  proof: InstalledCliProcessProof,
  stagedLauncher: string,
): boolean {
  const expected = path.join(
    path.dirname(path.dirname(stagedLauncher)),
    "scripts",
    "frg-detached-startup.test.mjs",
  );
  return proof.argv.length === 3 &&
    proof.argv[0] === "--test" &&
    proof.argv[1] === "--test-isolation=none" &&
    proof.argv[2] === expected;
}

function directProcessObservationPassed(
  fault: MatrixFaultState,
  result: SpawnSyncReturns<string>,
  fixture: InstalledCliProbeFixture,
): boolean {
  if (fault === "exception") return result.status === 1;
  // The launcher/Commander boundary may normalize an unhandled rejection to
  // its standard failure code. Qualification cares that it remains an
  // observable failure (never a false success), not which private sentinel
  // survives that boundary.
  if (fault === "rejection") return result.status !== null && result.status !== 0;
  if (fault === "nonzero_exit") return result.status === 23;
  if (fault === "signal") return result.signal === "SIGTERM";
  if (fault === "timeout") {
    return (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  }
  if (fault === "malformed_or_contradictory_output") {
    if (result.status !== 0) return false;
    try {
      JSON.parse(result.stdout);
      return false;
    } catch {
      return true;
    }
  }
  return false;
}

function recoveryObservations(
  result: SpawnSyncReturns<string>,
  fixture: InstalledCliProbeFixture,
): AdapterObservation[] | null {
  if (result.status !== 0 || result.signal !== null || result.error) return null;
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    if (
      parsed.schema === INSTALLED_CLI_PROBE_SCHEMA &&
      parsed.nonce === fixture.nonce &&
      parsed.operation === fixture.operation &&
      Array.isArray(parsed.observations)
    ) {
      return parsed.observations as AdapterObservation[];
    }
    return null;
  } catch {
    return null;
  }
}

function safeQualificationEnv(base: NodeJS.ProcessEnv, safeHome?: string): NodeJS.ProcessEnv {
  return {
    PATH: base.PATH,
    HOME: safeHome,
    TMPDIR: base.TMPDIR,
    AGENT_PIPELINE_NODE: base.AGENT_PIPELINE_NODE ?? process.execPath,
    NODE_NO_WARNINGS: "1",
  };
}

function stageCandidatePackage(sourceRoot: string, stageRoot: string, candidateSha: string): string {
  // A local shared clone checks out the requested object, not the caller's
  // possibly dirty working tree. It also gives launcher --version an honest
  // Git identity without a network fetch or mutation of the source checkout.
  execFileSync("git", ["clone", "--quiet", "--no-checkout", "--shared", sourceRoot, stageRoot], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  execFileSync("git", ["-C", stageRoot, "checkout", "--quiet", "--detach", candidateSha], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  const sourceCore = path.join(sourceRoot, "core");
  const stagedCore = path.join(stageRoot, "core");
  const sourceModules = path.join(sourceCore, "node_modules");
  if (!existsSync(sourceModules)) {
    throw new Error(`installed-CLI qualification dependencies missing: ${sourceModules}`);
  }
  symlinkSync(sourceModules, path.join(stagedCore, "node_modules"), "dir");
  return path.join(stageRoot, "scripts", "pipeline-launcher.mjs");
}

export interface RunInstalledCliQualificationOptions {
  candidateSha: string;
  launcherPath: string;
  repoDir: string;
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  timeoutMs?: number;
  coreSuiteTimeoutMs?: number;
  spawn?: typeof spawnSync;
}

export function qualificationArtifactPath(repoDir: string, candidateSha: string): string {
  return path.join(repoDir, ".agent-pipeline", "qualification", `${candidateSha}.json`);
}

export interface CandidateTestInventoryDeps {
  lsTree(repoRoot: string, candidateSha: string): string | null;
}

const defaultCandidateTestInventoryDeps: CandidateTestInventoryDeps = {
  lsTree: (repoRoot, candidateSha) => {
    try {
      return execFileSync(
        "git",
        ["-C", repoRoot, "ls-tree", "-r", "--name-only", candidateSha, "--", "core/test"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 },
      );
    } catch {
      return null;
    }
  },
};

/** Exact candidate test inventory. Live operator-worktree files are never read. */
export function candidateTestNamesAtCommit(
  launcherPath: string,
  candidateSha: string,
  deps: CandidateTestInventoryDeps = defaultCandidateTestInventoryDeps,
): string[] | null {
  if (!path.isAbsolute(launcherPath) || !EXACT_SHA.test(candidateSha)) return null;
  const repoRoot = path.resolve(path.dirname(launcherPath), "..");
  const listed = deps.lsTree(repoRoot, candidateSha);
  if (listed === null) return null;
  const names = listed
    .split(/\r?\n/)
    .filter((entry) => /^core\/test\/[A-Za-z0-9._-]+\.test\.ts$/.test(entry))
    .map((entry) => path.posix.basename(entry))
    .sort();
  return names.length > 0 && new Set(names).size === names.length ? names : null;
}

export function parseInstalledCliQualificationArtifact(
  value: unknown,
  candidateSha: string,
  inventoryDeps: CandidateTestInventoryDeps = defaultCandidateTestInventoryDeps,
): InstalledCliQualificationArtifact | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Partial<InstalledCliQualificationArtifact>;
  if (
    o.schema !== INSTALLED_CLI_QUALIFICATION_SCHEMA ||
    o.candidate_sha !== candidateSha ||
    !EXACT_SHA.test(candidateSha) ||
    typeof o.launcher !== "string" ||
    !path.isAbsolute(o.launcher) ||
    o.matrix_version !== FAULT_RECOVERY_MATRIX_VERSION ||
    typeof o.generated_at !== "string" ||
    !Number.isFinite(Date.parse(o.generated_at)) ||
    !Array.isArray(o.rows) ||
    !Array.isArray(o.proofs) ||
    typeof o.digest_sha256 !== "string"
  ) {
    return null;
  }
  const { digest_sha256, ...unsigned } = o as InstalledCliQualificationArtifact;
  if (digest_sha256 !== installedCliQualificationArtifactDigest(unsigned)) return null;
  const expectedCells = qualificationCells();
  if (o.rows.length !== expectedCells.length) return null;
  const keys = new Set(o.rows.map((row) => matrixCellKey(row)));
  if (keys.size !== o.rows.length) return null;
  if (expectedCells.some((cell) => !keys.has(matrixCellKey(cell)))) return null;
  const bound = bindExecutedMatrixRowsForCandidate(o.rows, candidateSha);
  if (bound.length !== o.rows.length) return null;
  const expectedKeys = new Set(expectedCells.map(matrixCellKey));
  const proofCells = new Set<string>();
  for (const proof of o.proofs) {
    if (
      !proof ||
      typeof proof.operation !== "string" ||
      !Array.isArray(proof.fault_states) ||
      !Array.isArray(proof.cell_keys) ||
      proof.fault_states.some(
        (fault) => !(MATRIX_FAULT_STATES as readonly string[]).includes(fault),
      ) ||
      !Array.isArray(proof.argv) ||
      proof.argv.some((arg) => typeof arg !== "string") ||
      !(
        proof.exit_code === null ||
        (typeof proof.exit_code === "number" &&
          Number.isSafeInteger(proof.exit_code) &&
          proof.exit_code >= 0 &&
          proof.exit_code <= 255)
      ) ||
      !(proof.signal === null || typeof proof.signal === "string") ||
      typeof proof.timed_out !== "boolean" ||
      typeof proof.stdout_sha256 !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(proof.stdout_sha256) ||
      !(proof.stdout_json === null || typeof proof.stdout_json === "boolean") ||
      !(proof.observations === undefined || Array.isArray(proof.observations))
    ) return null;
    if (proof.cell_keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))) return null;
    for (const key of proof.cell_keys) proofCells.add(key);
  }
  if (expectedCells.some((cell) => !proofCells.has(matrixCellKey(cell)))) return null;
  const typedProofs = o.proofs as InstalledCliProcessProof[];
  const operationCells = installedCells();
  const stagedLauncher = stagedLauncherFromProofs(typedProofs);
  if (!stagedLauncher) return null;
  const candidateTests = candidateTestNamesAtCommit(o.launcher, candidateSha, inventoryDeps);
  if (!candidateTests) return null;
  const expectedProofCount = requiredMatrixOperations().length * (PROCESS_FAULTS.size + 1) + 4;
  if (typedProofs.length !== expectedProofCount) return null;
  const routeProofs = typedProofs.filter((proof) => requiredMatrixOperations().includes(proof.operation));
  if (new Set(routeProofs.map((proof) => proof.argv[3])).size !== routeProofs.length) return null;
  for (const operation of requiredMatrixOperations()) {
    const routedCells = operationCells.filter((cell) => cell.operation === operation);
    const routedFaults = routedCells.map((cell) => cell.fault_state);
    const recoveryProofs = typedProofs.filter(
      (proof) => proof.operation === operation && proof.observations !== undefined,
    );
    if (recoveryProofs.length !== 1) return null;
    const recoveryProof = recoveryProofs[0]!;
    if (
      !routeProofArgvMatches(recoveryProof, operation, stagedLauncher) ||
      recoveryProof.exit_code !== 0 ||
      recoveryProof.signal !== null ||
      recoveryProof.timed_out ||
      recoveryProof.stdout_json !== true ||
      !sameFaultSet(recoveryProof.fault_states, routedFaults) ||
      !sameStringSet(
        recoveryProof.cell_keys,
        expectedCells
          .filter((cell) => cell.operation === operation)
          .map(matrixCellKey),
      ) ||
      recoveryProof.observations == null ||
      !sameFaultSet(
        recoveryProof.observations.map((observation) => observation.fault_state),
        routedFaults,
      ) ||
      routedCells.some((cell) =>
        !safeObservationForCell(
          recoveryProof.observations?.find(
            (observation) => observation.fault_state === cell.fault_state,
          ),
          cell,
        ))
    ) return null;
    for (const fault of PROCESS_FAULTS) {
      const processProofs = typedProofs.filter(
        (proof) =>
          proof.operation === operation &&
          proof.observations === undefined &&
          proof.fault_states.length === 1 &&
          proof.fault_states[0] === fault,
      );
      if (
        processProofs.length !== 1 ||
        !routeProofArgvMatches(processProofs[0]!, operation, stagedLauncher) ||
        !sameStringSet(
          processProofs[0]!.cell_keys,
          expectedCells
            .filter(
              (cell) =>
                cell.layer === "installed_cli" &&
                cell.operation === operation &&
                cell.fault_state === fault,
            )
            .map(matrixCellKey),
        ) ||
        !directProofMatchesFault(processProofs[0]!, fault)
      ) return null;
    }
  }
  const suiteDefinitions = [
    {
      operation: "adapter-contract-suite",
      layer: "adapter_contract",
      testNames: ["fault-recovery-matrix.test.ts"],
    },
    {
      operation: "host-conformance-suite",
      layer: "host_conformance",
      testNames: ["fault-recovery-host-conformance.test.ts"],
    },
    {
      operation: "candidate-core-suite",
      layer: null,
      testNames: candidateTests,
    },
  ] as const;
  for (const suiteDefinition of suiteDefinitions) {
    const suiteProofs = typedProofs.filter(
      (proof) => proof.operation === suiteDefinition.operation,
    );
    const suiteCells = suiteDefinition.layer === null
      ? []
      : expectedCells.filter((cell) => cell.layer === suiteDefinition.layer);
    if (
      suiteProofs.length !== 1 ||
      suiteProofs[0]!.exit_code !== 0 ||
      suiteProofs[0]!.signal !== null ||
      suiteProofs[0]!.timed_out ||
      !suiteProofArgvMatches(suiteProofs[0]!, stagedLauncher, suiteDefinition.testNames) ||
      !sameStringSet(suiteProofs[0]!.cell_keys, suiteCells.map(matrixCellKey)) ||
      !sameFaultSet(
        suiteProofs[0]!.fault_states,
        [...new Set(suiteCells.map((cell) => cell.fault_state))],
      )
    ) return null;
  }
  const detachedStartupProofs = typedProofs.filter(
    (proof) => proof.operation === "frg-detached-startup-suite",
  );
  if (
    detachedStartupProofs.length !== 1 ||
    detachedStartupProofs[0]!.exit_code !== 0 ||
    detachedStartupProofs[0]!.signal !== null ||
    detachedStartupProofs[0]!.timed_out ||
    detachedStartupProofs[0]!.cell_keys.length !== 0 ||
    detachedStartupProofs[0]!.fault_states.length !== 0 ||
    !detachedStartupProofArgvMatches(detachedStartupProofs[0]!, stagedLauncher)
  ) return null;
  for (const row of o.rows) {
    const cell = expectedCells.find((candidate) => matrixCellKey(candidate) === matrixCellKey(row));
    if (!cell) return null;
    const key = matrixCellKey(cell);
    const recoveryProof = typedProofs.find(
      (proof) =>
        proof.operation === cell.operation &&
        proof.cell_keys.includes(key) &&
        proof.exit_code === 0 &&
        proof.signal === null &&
        !proof.timed_out &&
        proof.stdout_json === true &&
        proof.fault_states.includes(cell.fault_state) &&
        proof.observations != null &&
        new Set(proof.observations.map((observation) => observation.fault_state)).size ===
          proof.observations.length &&
        proof.observations?.some((observation) => observation.fault_state === cell.fault_state),
    );
    const observation = recoveryProof?.observations?.find(
      (candidate) => candidate.fault_state === cell.fault_state,
    );
    if (!safeObservationForCell(observation, cell)) return null;
    if (cell.layer === "installed_cli" && PROCESS_FAULTS.has(cell.fault_state)) {
      const directProof = typedProofs.find(
        (proof) =>
          proof.operation === cell.operation &&
          proof.fault_states.length === 1 &&
          proof.fault_states[0] === cell.fault_state &&
          proof.cell_keys.includes(key) &&
          !proof.observations,
      );
      if (!directProof || !directProofMatchesFault(directProof, cell.fault_state)) return null;
    }
    if (cell.layer !== "installed_cli") {
      const expectedSuite = cell.layer === "adapter_contract"
        ? "adapter-contract-suite"
        : "host-conformance-suite";
      const suiteProof = typedProofs.find(
        (proof) =>
          proof.operation === expectedSuite &&
          proof.cell_keys.includes(key) &&
          proof.exit_code === 0 &&
          proof.signal === null &&
          !proof.timed_out,
      );
      if (!suiteProof) return null;
    }
  }
  return o as InstalledCliQualificationArtifact;
}

export function readInstalledCliQualificationArtifact(
  repoDir: string,
  candidateSha: string,
): InstalledCliQualificationArtifact | null {
  try {
    return parseInstalledCliQualificationArtifact(
      JSON.parse(readFileSync(qualificationArtifactPath(repoDir, candidateSha), "utf8")),
      candidateSha,
    );
  } catch {
    return null;
  }
}

export function runInstalledCliQualification(
  opts: RunInstalledCliQualificationOptions,
): InstalledCliQualificationArtifact {
  const candidateSha = opts.candidateSha.trim().toLowerCase();
  if (!EXACT_SHA.test(candidateSha)) throw new Error("installed-CLI qualification requires exact candidate SHA");
  const launcherPath = path.resolve(opts.launcherPath);
  if (!existsSync(launcherPath)) throw new Error(`installed-CLI qualification launcher missing: ${launcherPath}`);
  const existing = readInstalledCliQualificationArtifact(opts.repoDir, candidateSha);
  if (existing && existing.launcher === launcherPath) return existing;
  const spawn = opts.spawn ?? spawnSync;
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pipeline-installed-qualification-"));
  const safeHome = path.join(tempRoot, "home");
  mkdirSync(safeHome, { recursive: true, mode: 0o700 });
  let stagedLauncher: string;
  try {
    stagedLauncher = stageCandidatePackage(
      path.resolve(path.dirname(launcherPath), ".."),
      path.join(tempRoot, "package"),
      candidateSha,
    );
  } catch (err) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw err;
  }
  const identity = spawn(
    opts.nodePath ?? process.execPath,
    [stagedLauncher, "--version", "--json"],
    {
      cwd: opts.repoDir,
      env: safeQualificationEnv(opts.env ?? process.env, safeHome),
      encoding: "utf8",
      timeout: 10_000,
    },
  ) as SpawnSyncReturns<string>;
  let observedCandidate: string | null = null;
  try {
    const parsed = JSON.parse(identity.stdout ?? "") as Record<string, unknown>;
    observedCandidate = typeof parsed.commit_sha === "string" ? parsed.commit_sha : null;
  } catch {
    observedCandidate = null;
  }
  if (identity.status !== 0 || observedCandidate !== candidateSha) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(
      `installed-CLI qualification launcher candidate mismatch: expected ${candidateSha}, ` +
        `observed ${observedCandidate ?? "unavailable"}`,
    );
  }

  const cells = installedCells();
  const byOperation = new Map<string, typeof cells>();
  for (const cell of cells) {
    const list = byOperation.get(cell.operation) ?? [];
    list.push(cell);
    byOperation.set(cell.operation, list);
  }
  const rows: ExecutedMatrixRow[] = [];
  const proofs: InstalledCliProcessProof[] = [];
  const directProcessFailures = new Set<string>();
  const qualificationFailures: string[] = [];
  try {
    for (const [operation, operationCells] of byOperation) {
      const processCells = operationCells.filter((cell) => PROCESS_FAULTS.has(cell.fault_state));
      const batches = [
        ...processCells.map((cell) => ({ mode: "process" as const, cells: [cell] })),
        { mode: "recovery" as const, cells: operationCells },
      ];
      for (const batch of batches) {
        const fixture: InstalledCliProbeFixture = {
          schema: INSTALLED_CLI_PROBE_SCHEMA,
          nonce: randomBytes(16).toString("hex"),
          operation,
          fault_states: batch.cells.map((cell) => cell.fault_state),
          mode: batch.mode,
        };
        const fixturePath = path.join(tempRoot, `${operation.replace(/[^a-z0-9-]/gi, "_")}-${fixture.nonce}.json`);
        writeFileSync(fixturePath, canonicalJson(fixture), { mode: 0o600 });
        const routed = routeArgs(operation, fixturePath);
        const result = spawn(
          opts.nodePath ?? process.execPath,
          [stagedLauncher, ...routed],
          {
            cwd: opts.repoDir,
            env: safeQualificationEnv(opts.env ?? process.env, safeHome),
            encoding: "utf8",
            timeout:
              batch.mode === "process" && batch.cells[0]?.fault_state === "timeout"
                ? opts.timeoutMs ?? 250
                : 30_000,
            killSignal: "SIGKILL",
          },
        ) as SpawnSyncReturns<string>;
        const observations = batch.mode === "recovery"
          ? recoveryObservations(result, fixture)
          : null;
        const proofCells = batch.mode === "recovery"
          ? qualificationCells().filter((cell) => cell.operation === operation)
          : qualificationCells().filter(
              (cell) =>
                cell.layer === "installed_cli" &&
                cell.operation === operation &&
                cell.fault_state === batch.cells[0]?.fault_state,
            );
        proofs.push(
          proofFor(
            operation,
            fixture.fault_states,
            proofCells.map(matrixCellKey),
            [stagedLauncher, ...routed],
            result,
            observations ?? undefined,
          ),
        );
        if (batch.mode === "process") {
          if (!directProcessObservationPassed(batch.cells[0]!.fault_state, result, fixture)) {
            directProcessFailures.add(matrixCellKey(batch.cells[0]!));
            qualificationFailures.push(`${operation}/${batch.cells[0]!.fault_state}/process`);
          }
          continue;
        }
        for (const routedCell of batch.cells) {
          const routedObservation = observations?.find(
            (candidate) => candidate.fault_state === routedCell.fault_state,
          );
          if (!safeObservationForCell(routedObservation, routedCell)) {
            qualificationFailures.push(`${operation}/${routedCell.fault_state}/recovery`);
          }
        }
        for (const cell of proofCells) {
          const observation = observations?.find(
            (candidate) => candidate.fault_state === cell.fault_state,
          );
          const safe =
            safeObservationForCell(observation, cell) &&
            !directProcessFailures.has(matrixCellKey(cell));
          rows.push({
            candidate_sha: candidateSha,
            layer: cell.layer,
            lifecycle_class: cell.lifecycle_class,
            operation: cell.operation,
            fault_state: cell.fault_state,
            entrypoint: cell.entrypoint,
            host: cell.host,
            observed_terminal: observation?.unique_operation_terminal ?? "ownerless_terminal",
            passed: safe,
          });
        }
      }
    }

    // The other deterministic layers are real generated tests, not inventory
    // declarations. Run each layer's suite from the exact candidate package,
    // then run the complete core suite as a separate candidate-wide blocker.
    const nonInstalledCells = qualificationCells().filter((cell) => cell.layer !== "installed_cli");
    const candidateRoot = path.resolve(path.dirname(stagedLauncher), "..");
    const stagedTests = path.join(candidateRoot, "core", "test");
    const layerSuites = [
      {
        operation: "adapter-contract-suite",
        layer: "adapter_contract",
        files: ["fault-recovery-matrix.test.ts"],
      },
      {
        operation: "host-conformance-suite",
        layer: "host_conformance",
        files: ["fault-recovery-host-conformance.test.ts"],
      },
    ] as const;
    for (const layerSuite of layerSuites) {
      const layerCells = nonInstalledCells.filter((cell) => cell.layer === layerSuite.layer);
      const layerArgv = [
        "--test",
        "--experimental-strip-types",
        ...layerSuite.files.map((name) => path.join(stagedTests, name)),
      ];
      const layerResult = spawn(opts.nodePath ?? process.execPath, layerArgv, {
        cwd: path.join(candidateRoot, "core"),
        env: safeQualificationEnv(opts.env ?? process.env, safeHome),
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: TEST_SUITE_MAX_BUFFER_BYTES,
      }) as SpawnSyncReturns<string>;
      proofs.push(
        proofFor(
          layerSuite.operation,
          [...new Set(layerCells.map((cell) => cell.fault_state))],
          layerCells.map(matrixCellKey),
          layerArgv,
          layerResult,
        ),
      );
      if (layerResult.status !== 0 || layerResult.signal !== null || layerResult.error) {
        qualificationFailures.push(
          `${layerSuite.operation}(${processFailureSummary(layerResult)})`,
        );
        for (const row of rows) {
          if (row.layer === layerSuite.layer) row.passed = false;
        }
      }
    }
    const detachedStartupArgv = [
      "--test",
      "--test-isolation=none",
      path.join(candidateRoot, "scripts", "frg-detached-startup.test.mjs"),
    ];
    const detachedStartup = spawn(opts.nodePath ?? process.execPath, detachedStartupArgv, {
      cwd: candidateRoot,
      env: safeQualificationEnv(opts.env ?? process.env, safeHome),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: TEST_SUITE_MAX_BUFFER_BYTES,
    }) as SpawnSyncReturns<string>;
    proofs.push(
      proofFor(
        "frg-detached-startup-suite",
        [],
        [],
        detachedStartupArgv,
        detachedStartup,
      ),
    );
    if (
      detachedStartup.status !== 0 ||
      detachedStartup.signal !== null ||
      detachedStartup.error
    ) {
      qualificationFailures.push(
        `frg-detached-startup-suite(${processFailureSummary(detachedStartup)})`,
      );
    }
    const suiteArgv = [
      "--test",
      "--experimental-strip-types",
      ...readdirSync(stagedTests)
        .filter((name) => name.endsWith(".test.ts"))
        .sort()
        .map((name) => path.join(stagedTests, name)),
    ];
    const suite = spawn(opts.nodePath ?? process.execPath, suiteArgv, {
      cwd: path.join(candidateRoot, "core"),
      env: safeQualificationEnv(opts.env ?? process.env, safeHome),
      encoding: "utf8",
      timeout: opts.coreSuiteTimeoutMs ?? 300_000,
      maxBuffer: TEST_SUITE_MAX_BUFFER_BYTES,
    }) as SpawnSyncReturns<string>;
    proofs.push(
      proofFor(
        "candidate-core-suite",
        [],
        [],
        suiteArgv,
        suite,
      ),
    );
    if (suite.status !== 0 || suite.signal !== null || suite.error) {
      qualificationFailures.push(`candidate-core-suite(${processFailureSummary(suite)})`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  const failed = rows.filter((row) => !row.passed);
  if (failed.length > 0 || qualificationFailures.length > 0) {
    throw new Error(
      `installed-CLI qualification failed: ${[
        ...qualificationFailures,
        ...failed.map((row) => `${row.operation}/${row.fault_state}/row`),
      ].join(", ")}`,
    );
  }
  const unsigned: Omit<InstalledCliQualificationArtifact, "digest_sha256"> = {
    schema: INSTALLED_CLI_QUALIFICATION_SCHEMA,
    candidate_sha: candidateSha,
    launcher: launcherPath,
    matrix_version: FAULT_RECOVERY_MATRIX_VERSION,
    generated_at: (opts.now ?? (() => new Date()))().toISOString(),
    rows,
    proofs,
  };
  const artifact: InstalledCliQualificationArtifact = {
    ...unsigned,
    digest_sha256: installedCliQualificationArtifactDigest(unsigned),
  };
  const artifactPath = qualificationArtifactPath(opts.repoDir, candidateSha);
  mkdirSync(path.dirname(artifactPath), { recursive: true, mode: 0o700 });
  const temp = `${artifactPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  writeFileSync(temp, canonicalJson(artifact), { mode: 0o600 });
  renameSync(temp, artifactPath);
  return artifact;
}
