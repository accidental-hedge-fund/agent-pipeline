import { createHash, randomBytes } from "node:crypto";
import { chmod, link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWrapperArtifact } from "./artifact-proof.mjs";
import { validateMachineConfig } from "./config.mjs";
import { validateGrantEnvelope } from "./grant.mjs";
import {
  collectFrgPackObservations,
  FRG_HYBRID_PILOT_POLICY_ID,
  loadFrgPack,
  serializeFrgPackObservations,
} from "../trusted-frg/frg-pack-observations.ts";
import {
  buildFrgAttestationPayload,
  frgStableFingerprint,
  itemsFromLoopLedger,
  runFactoryGate,
  validateFrgPackContract,
  validateReleaseEligibleFrgEvidence,
} from "../trusted-frg/factory-reliability-gate.ts";

export const FRG_ATTESTOR_SCHEMA_VERSION = 1;
export const FRG_ATTESTOR_PILOT_VERSION = "1.33.0";
export const FRG_ATTESTOR_PACK_ID = "factory-gate-v1";
export const FRG_ATTESTOR_POLICY_ID = FRG_HYBRID_PILOT_POLICY_ID;

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40,64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REQUEST_KEYS = Object.freeze([
  "schema_version",
  "kind",
  "request_id",
  "grant_fingerprint",
  "action_id",
  "version",
  "repository",
  "base_branch",
  "candidate_git_sha",
  "manifest_sha256",
  "pack_run_id",
  "loop_run_id",
  "frg_run_id",
  "evidence_created_at",
  "observations_sha256",
  "evidence_bundle_sha256",
  "contract_sha256",
  "ledger_sha256",
  "events_sha256",
  "action_evidence_sha256",
]);
const RESULT_KEYS = Object.freeze([
  "schema_version",
  "kind",
  "status",
  "request_id",
  "grant_fingerprint",
  "action_id",
  "version",
  "loop_run_id",
  "pack_run_id",
  "candidate_git_sha",
  "manifest_sha256",
  "frg_run_id",
  "signer",
  "attestation_payload_sha256",
  "attested_evidence_sha256",
]);
const SIGNER_KEYS = Object.freeze(["mode", "version", "tag", "git_sha", "policy_id", "policy_sha256"]);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  const canonical = (entry) => {
    if (entry === null || typeof entry !== "object") return entry;
    if (Array.isArray(entry)) return entry.map(canonical);
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, canonical(entry[key])]));
  };
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function parseJson(text, name) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

function parseJsonLines(text, name) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error(`${name} is empty`);
  return lines.map((line, index) => parseJson(line, `${name} line ${index + 1}`));
}

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} fields are not exact`);
  }
}

function requireString(value, name, pattern = null) {
  if (typeof value !== "string" || value.trim() === "" || (pattern && !pattern.test(value))) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireSafeId(value, name) {
  const id = requireString(value, name, SAFE_ID_RE);
  if (id.includes("..")) throw new Error(`${name} is not safe`);
  return id;
}

function requireCanonicalTime(value, name) {
  requireString(value, name);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z") !== value) {
    throw new Error(`${name} must be a canonical whole-second UTC timestamp`);
  }
  return value;
}

async function assertOwnedMode(path, expectedModes, type, deps, name) {
  const info = await deps.stat(path);
  const expectedType = type === "directory" ? info.isDirectory() : info.isFile();
  if (!expectedType) throw new Error(`${name} must be a regular ${type}`);
  const mode = info.mode & 0o777;
  if (!expectedModes.includes(mode)) {
    throw new Error(`${name} mode must be ${expectedModes.map((entry) => entry.toString(8)).join(" or ")}`);
  }
  const uid = deps.getuid();
  if (uid !== null && info.uid !== uid) throw new Error(`${name} must be owned by the attestor user`);
}

async function secureMkdir(path, deps) {
  await deps.mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await deps.chmod(path, PRIVATE_DIRECTORY_MODE);
  await assertOwnedMode(path, [PRIVATE_DIRECTORY_MODE], "directory", deps, path);
}

async function immutableWrite(path, body, deps) {
  await secureMkdir(dirname(path), deps);
  const temporary = `${path}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    await deps.writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: PRIVATE_FILE_MODE });
    await deps.chmod(temporary, PRIVATE_FILE_MODE);
    await deps.link(temporary, path);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await assertOwnedMode(path, [PRIVATE_FILE_MODE], "file", deps, path);
    if (await deps.readFile(path, "utf8") !== body) {
      throw new Error(`refusing to replace different immutable artifact ${path}`);
    }
  } finally {
    await deps.unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  await deps.chmod(path, PRIVATE_FILE_MODE);
  await assertOwnedMode(path, [PRIVATE_FILE_MODE], "file", deps, path);
}

function sameSet(actual, expected) {
  const left = [...actual].map(String).sort();
  const right = [...expected].map(String).sort();
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function itemIdFromRecord(record) {
  for (const value of [record?.item_id, record?.data?.item_id]) {
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

export function frgAttestationLayout(config, request) {
  const runDir = join(
    resolve(config.state_dir),
    "frg",
    request.grant_fingerprint,
    request.version,
    request.pack_run_id,
  );
  return Object.freeze({
    request_root: resolve(config.frg_scorer_request_dir),
    run_dir: runDir,
    observations_path: join(runDir, "observations.json"),
    evidence_bundle_path: join(runDir, "evidence-bundle.json"),
    contract_path: join(runDir, "contract.json"),
    ledger_path: join(runDir, "ledger.json"),
    events_path: join(runDir, "events.jsonl"),
    action_evidence_path: join(runDir, "action-evidence.jsonl"),
    attested_evidence_path: join(runDir, "attested-evidence.json"),
    result_path: join(runDir, "attestation-result.json"),
  });
}

export function validateFrgAttestationRequest(raw, requestPath, scorerRequestRoot) {
  exactKeys(raw, REQUEST_KEYS, "FRG attestation request");
  if (typeof raw.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(raw.version)) {
    throw new Error("FRG attestation request version is invalid");
  }
  if (raw.version !== FRG_ATTESTOR_PILOT_VERSION) {
    throw new Error(
      `unsupported FRG attestation policy for v${raw.version}; issue #908 must supply the verified production policy`,
    );
  }
  if (
    raw.schema_version !== FRG_ATTESTOR_SCHEMA_VERSION ||
    raw.kind !== "frg_attestation_request" ||
    raw.version !== FRG_ATTESTOR_PILOT_VERSION ||
    !DIGEST_RE.test(raw.grant_fingerprint ?? "") ||
    !REPOSITORY_RE.test(raw.repository ?? "") ||
    !GIT_SHA_RE.test(raw.candidate_git_sha ?? "") ||
    !DIGEST_RE.test(raw.manifest_sha256 ?? "")
  ) {
    throw new Error("FRG attestation request identity is invalid");
  }
  for (const [name, value] of [
    ["request_id", raw.request_id],
    ["action_id", raw.action_id],
    ["pack_run_id", raw.pack_run_id],
    ["loop_run_id", raw.loop_run_id],
    ["frg_run_id", raw.frg_run_id],
  ]) requireSafeId(value, `FRG attestation ${name}`);
  requireString(raw.base_branch, "FRG attestation base_branch");
  requireCanonicalTime(raw.evidence_created_at, "FRG attestation evidence_created_at");
  for (const field of [
    "observations_sha256",
    "evidence_bundle_sha256",
    "contract_sha256",
    "ledger_sha256",
    "events_sha256",
    "action_evidence_sha256",
  ]) {
    if (!DIGEST_RE.test(raw[field] ?? "")) throw new Error(`FRG attestation ${field} is invalid`);
  }
  const root = resolve(scorerRequestRoot);
  if (
    basename(root) !== "frg-scorer-requests" ||
    resolve(root, `${raw.request_id}.json`) !== resolve(requestPath)
  ) {
    throw new Error("FRG attestation request filename does not match request_id");
  }
  return Object.freeze({ ...raw });
}

export function validateFrgAttestationResult(raw, request) {
  exactKeys(raw, RESULT_KEYS, "FRG attestation result");
  if (
    raw.schema_version !== FRG_ATTESTOR_SCHEMA_VERSION ||
    raw.kind !== "frg_attestation_result" ||
    raw.status !== "complete" ||
    raw.request_id !== request.request_id ||
    raw.grant_fingerprint !== request.grant_fingerprint ||
    raw.action_id !== request.action_id ||
    raw.version !== request.version ||
    raw.loop_run_id !== request.loop_run_id ||
    raw.pack_run_id !== request.pack_run_id ||
    raw.candidate_git_sha !== request.candidate_git_sha ||
    raw.manifest_sha256 !== request.manifest_sha256 ||
    raw.frg_run_id !== request.frg_run_id ||
    !DIGEST_RE.test(raw.attestation_payload_sha256 ?? "") ||
    !DIGEST_RE.test(raw.attested_evidence_sha256 ?? "")
  ) {
    throw new Error("FRG attestation result identity is invalid");
  }
  exactKeys(raw.signer, SIGNER_KEYS, "FRG attestation signer");
  for (const field of ["mode", "version", "tag", "policy_id"]) requireSafeId(raw.signer[field], `FRG signer ${field}`);
  requireString(raw.signer.git_sha, "FRG signer git_sha", GIT_SHA_RE);
  requireString(raw.signer.policy_sha256, "FRG signer policy_sha256", DIGEST_RE);
  return Object.freeze({ ...raw, signer: Object.freeze({ ...raw.signer }) });
}

async function policyIdentity(config, deps) {
  const paths = [
    "trusted-frg/factory-reliability-gate.ts",
    "trusted-frg/frg-pack-observations.ts",
    "trusted-frg/loop/types.ts",
  ];
  const files = [];
  for (const relativePath of paths) {
    const body = await deps.readFile(join(config.wrapper_dir, relativePath));
    files.push({ path: relativePath, sha256: digest(body) });
  }
  return {
    mode: "bootstrap-wrapper",
    version: FRG_ATTESTOR_PILOT_VERSION,
    tag: "v1.33.0-bootstrap-policy",
    git_sha: config.wrapper_git_sha,
    policy_id: FRG_ATTESTOR_POLICY_ID,
    policy_sha256: digest(canonicalJson({ policy_id: FRG_ATTESTOR_POLICY_ID, files })),
  };
}

export async function verifyFrgAttestorTrustRoot(request, deps) {
  const configPath = resolve(deps.machineConfigPath);
  await assertOwnedMode(configPath, [0o400, PRIVATE_FILE_MODE], "file", deps, "Hermes factory machine config");
  const config = validateMachineConfig(
    parseJson(await deps.readFile(configPath, "utf8"), "Hermes factory machine config"),
    { requireEnabled: true },
  );
  const layout = frgAttestationLayout(config, request);
  if (
    resolve(config.frg_scorer_request_dir) !== resolve(deps.scorerRequestRoot) ||
    config.repository !== request.repository ||
    config.base_branch !== request.base_branch ||
    config.frg_pack_manifest_sha256 !== request.manifest_sha256 ||
    resolve(config.frg_pack_manifest) !== join(resolve(config.repo_dir), "core", "scripts", "frg-packs", "factory-gate-v1", "manifest.json") ||
    resolve(config.frg_runner_command[1]) !== join(resolve(config.wrapper_dir), "lib", "frg-runner.mjs") ||
    resolve(fileURLToPath(import.meta.url)) !== join(resolve(config.wrapper_dir), "lib", "frg-attestor.mjs")
  ) {
    throw new Error("FRG attestation request does not match the deployed machine trust root");
  }
  await (deps.verifyWrapperArtifact ?? verifyWrapperArtifact)(config, deps.readFile);

  await assertOwnedMode(config.active_grant_file, [0o400, PRIVATE_FILE_MODE], "file", deps, "active Hermes factory grant");
  const validatedGrant = validateGrantEnvelope(
    parseJson(await deps.readFile(config.active_grant_file, "utf8"), "active Hermes factory grant"),
    config,
    { now: deps.now },
  );
  if (
    validatedGrant.fingerprint !== request.grant_fingerprint ||
    validatedGrant.grant.repository !== request.repository ||
    validatedGrant.grant.base_branch !== request.base_branch ||
    validatedGrant.grant.release_version !== request.version ||
    !validatedGrant.grant.actions.includes("frg")
  ) {
    throw new Error("FRG attestation request does not match the signed active grant");
  }

  const activePath = join(config.state_dir, "active.json");
  const journalPath = join(config.state_dir, "runs", `${validatedGrant.fingerprint}.json`);
  await Promise.all([
    assertOwnedMode(activePath, [PRIVATE_FILE_MODE], "file", deps, "active Hermes factory journal binding"),
    assertOwnedMode(journalPath, [PRIVATE_FILE_MODE], "file", deps, "Hermes factory grant journal"),
  ]);
  const active = parseJson(await deps.readFile(activePath, "utf8"), "active Hermes factory journal binding");
  const journal = parseJson(await deps.readFile(journalPath, "utf8"), "Hermes factory grant journal");
  if (
    active?.fingerprint !== validatedGrant.fingerprint ||
    active?.status !== "running" ||
    journal?.grant_fingerprint !== validatedGrant.fingerprint ||
    journal?.status !== "running"
  ) {
    throw new Error("FRG attestation request has no matching active factory journal");
  }
  const actions = Object.values(journal.actions ?? {});
  const integrated = actions.filter((action) =>
    action?.kind === "integrated_candidate" &&
    action?.state === "completed" &&
    action?.result?.git_sha === request.candidate_git_sha,
  );
  const frg = actions.filter((action) =>
    action?.action_id === request.action_id &&
    action?.kind === "frg" &&
    ["running", "ambiguous"].includes(action?.state) &&
    action?.target?.version === request.version &&
    action?.target?.pack_id === FRG_ATTESTOR_PACK_ID &&
    action?.target?.manifest_sha256 === request.manifest_sha256 &&
    action?.target?.candidate_git_sha === request.candidate_git_sha,
  );
  if (
    integrated.length !== 1 ||
    frg.length !== 1 ||
    journal.current?.action_id !== request.action_id ||
    journal.current?.kind !== "frg"
  ) {
    throw new Error("FRG attestation request is not bound to the active integrated candidate and FRG action");
  }
  return Object.freeze({ config, layout, signer: await policyIdentity(config, deps) });
}

function validateRawArtifacts(request, bundle, observations, raw) {
  const provenance = observations.pack_provenance;
  if (
    bundle.policy_id !== FRG_ATTESTOR_POLICY_ID ||
    bundle.pack_id !== FRG_ATTESTOR_PACK_ID ||
    bundle.release_version !== request.version ||
    bundle.candidate_git_sha !== request.candidate_git_sha ||
    bundle.manifest_sha256 !== request.manifest_sha256 ||
    bundle.pack_run_id !== request.pack_run_id ||
    bundle.loop_run_id !== request.loop_run_id ||
    bundle.repository !== request.repository ||
    bundle.base_branch !== request.base_branch ||
    provenance?.policy_id !== FRG_ATTESTOR_POLICY_ID ||
    provenance?.release_version !== request.version ||
    provenance?.candidate_git_sha !== request.candidate_git_sha ||
    provenance?.manifest_sha256 !== request.manifest_sha256 ||
    provenance?.pack_run_id !== request.pack_run_id ||
    provenance?.loop_run_id !== request.loop_run_id ||
    provenance?.repository !== request.repository ||
    provenance?.base_branch !== request.base_branch
  ) {
    throw new Error("FRG attestation artifacts do not bind the exact request identity");
  }
  const hashes = {
    contract: digest(raw.contract_text),
    ledger: digest(raw.ledger_text),
    events: digest(raw.events_text),
    action_evidence: digest(raw.action_evidence_text),
  };
  for (const name of Object.keys(hashes)) {
    const requestField = `${name}_sha256`;
    const bundleField = name === "action_evidence" ? bundle.action_evidence : bundle[name];
    const provenanceField = `${name}_sha256`;
    if (
      hashes[name] !== request[requestField] ||
      hashes[name] !== bundleField?.artifact_sha256 ||
      hashes[name] !== provenance?.[provenanceField]
    ) {
      throw new Error(`FRG ${name} raw artifact does not match its bound digest`);
    }
  }
  if (
    raw.contract?.run_id !== request.loop_run_id ||
    raw.ledger?.run_id !== request.loop_run_id ||
    raw.contract?.schema !== "pipeline/loop-contract@1" ||
    raw.ledger?.schema !== "pipeline/loop-ledger@1"
  ) {
    throw new Error("FRG raw contract and ledger do not bind the loop run");
  }
  const issueNumbers = provenance.issues.map((issue) => issue.issue_number);
  const contractCheck = validateFrgPackContract(raw.contract, issueNumbers);
  if (!contractCheck.ok) throw new Error(`FRG raw contract is not the fixed pack: ${contractCheck.detail}`);
  const contractSummary = {
    artifact_sha256: hashes.contract,
    selector: raw.contract.selector,
    issue_numbers: raw.contract.items.map((item) => Number(item.id)),
    items: raw.contract.items.map((item) => ({
      issue_number: Number(item.id),
      depends_on: (item.depends_on ?? []).map(Number),
    })),
  };
  const ledgerEntries = Object.entries(raw.ledger.items ?? {});
  const ledgerSummary = {
    artifact_sha256: hashes.ledger,
    items: ledgerEntries.map(([id, item]) => ({
      issue_number: Number(id),
      state: item?.state,
      advance_run_id: item?.advance_run_id,
      blocked_theme: item?.blocked_theme ?? null,
    })),
  };
  const eventsSummary = {
    artifact_sha256: hashes.events,
    event_ids: raw.events.map((event) => `event:${event?.seq}:${event?.kind}`),
    issue_numbers: [...new Set(raw.events.map(itemIdFromRecord).filter(Boolean))],
  };
  const actionSummary = {
    artifact_sha256: hashes.action_evidence,
    action_ids: raw.action_evidence.map((action) => `action:${action?.seq}:${action?.action}`),
    issue_numbers: [...new Set(raw.action_evidence.map(itemIdFromRecord).filter(Boolean))],
  };
  for (const [name, actual, expected] of [
    ["contract", contractSummary, bundle.contract],
    ["ledger", ledgerSummary, bundle.ledger],
    ["events", eventsSummary, bundle.events],
    ["action_evidence", actionSummary, bundle.action_evidence],
  ]) {
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error(`FRG raw ${name} does not reproduce the verified bundle summary`);
    }
  }
  if (
    !sameSet(Object.keys(raw.ledger.items ?? {}), issueNumbers) ||
    ledgerEntries.some(([, item]) => item?.state !== "ready" || item?.blocked_theme != null)
  ) {
    throw new Error("FRG raw ledger is not the exact clean fixed-pack result");
  }
}

function attestationPayload(evidence) {
  return buildFrgAttestationPayload({
    schema_version: evidence.schema_version,
    version: evidence.version,
    run_id: evidence.run_id,
    loop_run_id: evidence.loop_run_id,
    pack_id: evidence.pack_id,
    pass: evidence.pass,
    thresholds: evidence.thresholds,
    scenarios: evidence.scenarios,
    scoreboard: evidence.scoreboard,
    composition: evidence.composition,
    recovery_aggregates: evidence.recovery_aggregates,
    scoreboard_fingerprint: evidence.integrity.scoreboard_fingerprint,
    composition_fingerprint: evidence.integrity.composition_fingerprint,
    pack_provenance: evidence.pack_provenance,
    pack_provenance_fingerprint: evidence.integrity.pack_provenance_fingerprint,
  });
}

function defaultDeps(overrides = {}) {
  return {
    env: process.env,
    now: () => new Date(),
    readFile,
    writeFile,
    link,
    mkdir,
    chmod,
    stat,
    unlink,
    getuid: () => typeof process.getuid === "function" ? process.getuid() : null,
    machineConfigPath: join(homedir(), ".config", "hermes-factory", "config.json"),
    scorerRequestRoot: join(homedir(), ".local", "state", "hermes-factory", "frg-scorer-requests"),
    verifyTrustRoot: verifyFrgAttestorTrustRoot,
    ...overrides,
  };
}

export async function attestFrgRequest(requestPath, overrides = {}) {
  const deps = defaultDeps(overrides);
  const resolvedRequestPath = resolve(requestPath);
  const scorerRequestRoot = resolve(deps.scorerRequestRoot);
  if (resolve(scorerRequestRoot, basename(resolvedRequestPath)) !== resolvedRequestPath) {
    throw new Error("FRG attestation request is outside the configured request root");
  }
  await assertOwnedMode(scorerRequestRoot, [PRIVATE_DIRECTORY_MODE], "directory", deps, "FRG attestation request root");
  await assertOwnedMode(resolvedRequestPath, [PRIVATE_FILE_MODE], "file", deps, "FRG attestation request");
  const request = validateFrgAttestationRequest(
    parseJson(await deps.readFile(resolvedRequestPath, "utf8"), "FRG attestation request"),
    resolvedRequestPath,
    scorerRequestRoot,
  );
  const trust = await deps.verifyTrustRoot(request, deps);
  const { config } = trust;
  const layout = frgAttestationLayout(config, request);
  if (
    trust.layout &&
    canonicalJson(trust.layout) !== canonicalJson(layout)
  ) {
    throw new Error("FRG attestation trust root returned another artifact layout");
  }
  await assertOwnedMode(layout.run_dir, [PRIVATE_DIRECTORY_MODE], "directory", deps, "FRG run directory");
  const artifactPaths = [
    layout.observations_path,
    layout.evidence_bundle_path,
    layout.contract_path,
    layout.ledger_path,
    layout.events_path,
    layout.action_evidence_path,
  ];
  await Promise.all(artifactPaths.map((path) => assertOwnedMode(path, [PRIVATE_FILE_MODE], "file", deps, path)));
  const [observationsText, bundleText, contractText, ledgerText, eventsText, actionEvidenceText] = await Promise.all(
    artifactPaths.map((path) => deps.readFile(path, "utf8")),
  );
  if (
    digest(observationsText) !== request.observations_sha256 ||
    digest(bundleText) !== request.evidence_bundle_sha256
  ) {
    throw new Error("FRG attestation observation or bundle digest does not match the request");
  }
  const pack = await loadFrgPack(dirname(config.frg_pack_manifest), {
    readFile: (path) => deps.readFile(path, "utf8"),
  });
  if (pack.manifest_sha256 !== request.manifest_sha256) {
    throw new Error("trusted FRG policy loaded another manifest");
  }
  const bundle = parseJson(bundleText, "FRG evidence bundle");
  const projected = collectFrgPackObservations(pack, bundle);
  if (serializeFrgPackObservations(projected) !== observationsText) {
    throw new Error("FRG observations are not the exact trusted projection of the evidence bundle");
  }
  const raw = {
    contract_text: contractText,
    ledger_text: ledgerText,
    events_text: eventsText,
    action_evidence_text: actionEvidenceText,
    contract: parseJson(contractText, "FRG loop contract"),
    ledger: parseJson(ledgerText, "FRG loop ledger"),
    events: parseJsonLines(eventsText, "FRG loop events"),
    action_evidence: parseJsonLines(actionEvidenceText, "FRG loop action evidence"),
  };
  validateRawArtifacts(request, bundle, projected, raw);

  // The secret is read only after the closed request, trust root, policy,
  // artifact digests, and trusted projection have passed. No candidate module
  // or child process runs in this credentialed process. This is process-level
  // non-propagation, not an OS privilege boundary: the pilot accepts the broad
  // authority of other processes running as the same deployment user.
  const credentialsDirectory = requireString(deps.env?.CREDENTIALS_DIRECTORY, "CREDENTIALS_DIRECTORY");
  if (!isAbsolute(credentialsDirectory)) throw new Error("CREDENTIALS_DIRECTORY must be absolute");
  const credentialPath = join(resolve(credentialsDirectory), "frg_attestation_key");
  await assertOwnedMode(credentialPath, [0o400, PRIVATE_FILE_MODE], "file", deps, "FRG attestation credential");
  const key = String(await deps.readFile(credentialPath, "utf8")).trim();
  if (!key) throw new Error("FRG attestation credential is empty");

  const score = await runFactoryGate({
    version: request.version,
    repoDir: config.repo_dir,
    scoreInput: {
      version: request.version,
      run_id: request.frg_run_id,
      loop_run_id: request.loop_run_id,
      pack_id: FRG_ATTESTOR_PACK_ID,
      items: itemsFromLoopLedger(raw.ledger),
      scenario_overrides: projected.scenarios,
      composition_overrides: projected.composition,
      false_human_authority_count: projected.false_human_authority_count,
      recovery_aggregates: projected.recovery_aggregates,
      pack_provenance: projected.pack_provenance,
      now: () => new Date(request.evidence_created_at),
      attestation_key: key,
    },
    packProvenance: projected.pack_provenance,
    writeEvidence: false,
    attestationKey: key,
    stdout: () => {},
    stderr: () => {},
  });
  if (score.exitCode !== 0 || score.evidence.pass !== true) {
    throw new Error("trusted FRG policy did not produce a release-eligible pass");
  }
  const evidence = validateReleaseEligibleFrgEvidence(score.evidence, request.version, { attestationKey: key });
  if (
    evidence.run_id !== request.frg_run_id ||
    evidence.loop_run_id !== request.loop_run_id ||
    evidence.pack_provenance?.pack_run_id !== request.pack_run_id ||
    evidence.pack_provenance?.candidate_git_sha !== request.candidate_git_sha
  ) {
    throw new Error("trusted FRG evidence does not bind the attestation request");
  }
  const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
  await immutableWrite(layout.attested_evidence_path, evidenceText, deps);
  const result = validateFrgAttestationResult({
    schema_version: FRG_ATTESTOR_SCHEMA_VERSION,
    kind: "frg_attestation_result",
    status: "complete",
    request_id: request.request_id,
    grant_fingerprint: request.grant_fingerprint,
    action_id: request.action_id,
    version: request.version,
    loop_run_id: request.loop_run_id,
    pack_run_id: request.pack_run_id,
    candidate_git_sha: request.candidate_git_sha,
    manifest_sha256: request.manifest_sha256,
    frg_run_id: request.frg_run_id,
    signer: trust.signer ?? await policyIdentity(config, deps),
    attestation_payload_sha256: frgStableFingerprint(attestationPayload(evidence)),
    attested_evidence_sha256: digest(evidenceText),
  }, request);
  await immutableWrite(layout.result_path, canonicalJson(result), deps);
  return result;
}

export function parseFrgAttestorCli(argv) {
  if (argv.length !== 3 || argv[0] !== "attest" || argv[1] !== "--request" || !isAbsolute(argv[2])) {
    throw new Error("expected attest --request <absolute-path>");
  }
  return { mode: "attest", request: argv[2] };
}

async function main() {
  const parsed = parseFrgAttestorCli(process.argv.slice(2));
  await attestFrgRequest(parsed.request);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`FRG attestor failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
