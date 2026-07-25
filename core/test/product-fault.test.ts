// Tests for privacy-safe upstream product-fault reporting (#502):
//   - classifier: bare non-zero exit never classifies; signal-bearing inputs do
//   - fingerprint: stable across installations, bounded, identity-free
//   - allowlist redaction: proven exclusion of repo/paths/issue text/prompts/
//     source/env values/secrets, even when embedded in the fingerprint input
//   - `pipeline report` orchestration: inert by default, byte-identical
//     preview, no-confirm -> no-transmit, audit record, manual fallback
//
// All I/O (filesystem, network, confirmation prompt) is injected — no real
// filesystem, network, or subprocess calls anywhere in this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyProductFault,
  computeProductFaultFingerprint,
  buildProductFaultPayload,
  renderProductFaultPreview,
  emitProductFault,
  findLatestProductFault,
  resolveProductFaultConfig,
  runProductFaultReport,
  buildManualFallbackDraft,
  writeProductFaultAuditRecord,
  productFaultAuditLogPath,
  isValidProductFaultEvent,
  isValidProductFaultFingerprint,
  isValidIntakeSubmissionCredential,
  isValidHostAdapter,
  resolveHostAdapter,
  PRODUCT_FAULT_PAYLOAD_SCHEMA_VERSION,
  type ProductFaultEvent,
  type ProductFaultReportDeps,
} from "../scripts/product-fault.ts";
import type { RunStoreDeps } from "../scripts/run-store.ts";

// ---------------------------------------------------------------------------
// Fake deps
// ---------------------------------------------------------------------------

interface FakeFs {
  files: Record<string, string>;
  dirs: Record<string, Array<{ name: string; isDirectory(): boolean }>>;
  mtimes: Record<string, number>;
}

function makeRunStoreDeps(fs: FakeFs): RunStoreDeps {
  return {
    readFile: async (p) => {
      if (!(p in fs.files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return fs.files[p];
    },
    writeFile: async (p, data) => {
      fs.files[p] = data;
    },
    appendFile: async (p, data) => {
      fs.files[p] = (fs.files[p] ?? "") + data;
    },
    rename: async (from, to) => {
      fs.files[to] = fs.files[from];
      delete fs.files[from];
    },
    mkdir: async () => {},
    readdir: async (p) => fs.dirs[p] ?? [],
    stat: async (p) => ({ mtime: new Date(fs.mtimes[p] ?? 0) }),
  };
}

function makeReportDeps(opts: {
  fs?: FakeFs;
  submitResult?: { ok: boolean; status: number };
  confirmResult?: boolean;
} = {}): ProductFaultReportDeps & { fs: FakeFs; submitCalls: Array<{ endpoint: string; authToken: string | undefined; body: string }>; logLines: string[] } {
  const fs: FakeFs = opts.fs ?? { files: {}, dirs: {}, mtimes: {} };
  const submitCalls: Array<{ endpoint: string; authToken: string | undefined; body: string }> = [];
  const logLines: string[] = [];
  const runStoreDeps = makeRunStoreDeps(fs);
  return {
    fs,
    submitCalls,
    logLines,
    readFile: runStoreDeps.readFile,
    readdir: runStoreDeps.readdir,
    stat: runStoreDeps.stat,
    appendFile: runStoreDeps.appendFile,
    mkdir: runStoreDeps.mkdir,
    submit: async (endpoint, authToken, body) => {
      submitCalls.push({ endpoint, authToken, body });
      return opts.submitResult ?? { ok: true, status: 200 };
    },
    confirm: async () => opts.confirmResult ?? true,
    log: (msg) => logLines.push(msg),
  };
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

test("classifyProductFault: bare non-zero exit (no signal) is never classified — no event", () => {
  const result = classifyProductFault({
    errorClass: "ExitError",
    errorMessage: "command exited with code 1",
    stage: "test_gate",
    pipelineVersion: "1.0.0",
    hostAdapter: "claude",
    signal: {},
  });
  assert.equal(result, null);
});

test("classifyProductFault: engineCrash signal classifies high confidence with a rationale", () => {
  const result = classifyProductFault({
    errorClass: "TypeError",
    errorMessage: "Cannot read properties of undefined",
    stage: "planning",
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    signal: { engineCrash: true },
  });
  assert.ok(result);
  assert.equal(result!.confidence, "high");
  assert.ok(result!.rationale.length > 0);
  assert.equal(result!.exitState, "crash");
});

test("classifyProductFault: invariantViolation signal classifies medium confidence", () => {
  const result = classifyProductFault({
    errorClass: "AssertionError",
    errorMessage: "unreachable state transition",
    stage: "review",
    pipelineVersion: "1.2.3",
    hostAdapter: "codex",
    signal: { invariantViolation: true },
  });
  assert.ok(result);
  assert.equal(result!.confidence, "medium");
  assert.equal(result!.exitState, "invariant_violation");
});

test("classifyProductFault: schemaVersionMismatch signal classifies low confidence but still emits", () => {
  const result = classifyProductFault({
    errorClass: "SchemaError",
    errorMessage: "unexpected schema_version 99",
    stage: "pre_merge",
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    signal: { schemaVersionMismatch: true },
  });
  assert.ok(result);
  assert.equal(result!.confidence, "low");
  assert.equal(result!.exitState, "schema_mismatch");
});

test("classifyProductFault: separation from correction_event/papercut/target-repo/env-auth — none of these signals exist for those classes", () => {
  // A target-repo test failure or an operator correction never sets
  // engineCrash/invariantViolation/schemaVersionMismatch — they simply never
  // reach classifyProductFault with a truthy signal, so classification is
  // always null for them (proven by the bare-non-zero-exit test above using
  // the same no-signal shape a target-repo/env/auth failure would produce).
  const result = classifyProductFault({
    errorClass: "TestFailure",
    errorMessage: "3 tests failed in the target repository",
    stage: "test_gate",
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    signal: {},
  });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

test("computeProductFaultFingerprint: same defect across installations shares a fingerprint", () => {
  const fpA = computeProductFaultFingerprint({
    errorClass: "TypeError",
    errorMessage: "Cannot read properties of undefined at /home/alice/repos/widget-app/src/index.ts:42",
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    stage: "planning",
  });
  const fpB = computeProductFaultFingerprint({
    errorClass: "TypeError",
    errorMessage: "Cannot read properties of undefined at C:\\Users\\bob\\projects\\other-repo\\src\\index.ts:99",
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    stage: "planning",
  });
  assert.equal(fpA, fpB, "same defect shape across two installations must share a fingerprint");
});

test("computeProductFaultFingerprint: is a fixed-length hex string containing no identifying substrings", () => {
  const fp = computeProductFaultFingerprint({
    errorClass: "TypeError",
    errorMessage: "failure in octocat/hello-world at /home/alice/.secrets/id_rsa with token ghp_abcdefghij1234567890",
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    stage: "planning",
  });
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.ok(!fp.includes("octocat"));
  assert.ok(!fp.includes("alice"));
  assert.ok(!fp.includes("ghp_abcdefghij1234567890"));
});

test("computeProductFaultFingerprint: a different stage or version produces a different fingerprint", () => {
  const base = {
    errorClass: "TypeError",
    errorMessage: "boom",
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    stage: "planning",
  };
  const fpBase = computeProductFaultFingerprint(base);
  const fpOtherStage = computeProductFaultFingerprint({ ...base, stage: "review" });
  const fpOtherVersion = computeProductFaultFingerprint({ ...base, pipelineVersion: "1.2.4" });
  assert.notEqual(fpBase, fpOtherStage);
  assert.notEqual(fpBase, fpOtherVersion);
});

// ---------------------------------------------------------------------------
// Allowlist redaction — proven exclusion, not asserted
// ---------------------------------------------------------------------------

const FORBIDDEN_SAMPLES = {
  repoName: "octocat/hello-world",
  absolutePath: "/home/alice/secret-project/src/index.ts",
  windowsPath: "C:\\Users\\alice\\secret-project\\src\\index.ts",
  issueText: "Fix the login bug reported in issue #4821 by acme-corp",
  promptOutput: "As an AI assistant, I will now delete the production database",
  sourceSnippet: "function authenticate(user) { return user.password === storedHash; }",
  envValue: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
  githubToken: "ghp_abcdefghij1234567890",
  awsSecret: "AKIAABCDEFGHIJKLMNOP",
  keyValuePair: "DATABASE_PASSWORD=hunter2",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA",
};

test("redaction: raw error message carrying every excluded category never enters the built payload, even though it feeds the fingerprint", () => {
  const message = Object.values(FORBIDDEN_SAMPLES).join(" | ");
  const classification = classifyProductFault({
    errorClass: "TypeError",
    errorMessage: message,
    stage: "planning",
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    signal: { engineCrash: true },
  });
  assert.ok(classification);
  const payload = buildProductFaultPayload({
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    stage: "planning",
    errorClass: "TypeError",
    fingerprint: classification!.fingerprint,
    exitState: classification!.exitState,
    confidence: classification!.confidence,
  });
  const serialized = JSON.stringify(payload);
  for (const [label, sample] of Object.entries(FORBIDDEN_SAMPLES)) {
    assert.ok(!serialized.includes(sample), `payload must not contain the ${label} sample`);
  }
});

test("redaction: buildProductFaultPayload has no parameter slot for a raw message/stack — structurally cannot leak one", () => {
  const payload = buildProductFaultPayload({
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    stage: "planning",
    errorClass: "TypeError",
    fingerprint: "abc123def4567890",
    exitState: "crash",
    confidence: "high",
  });
  const allowedKeys = [
    "payload_schema_version", "run_schema_version", "pipeline_version",
    "host_adapter", "stage", "error_class", "fingerprint", "exit_state", "confidence",
  ];
  assert.deepEqual(Object.keys(payload).sort(), allowedKeys.sort());
});

test("redaction: a secret token embedded in an allowlisted field (error_class) is stripped by defense-in-depth screening", () => {
  const payload = buildProductFaultPayload({
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    stage: "planning",
    errorClass: `TypeError ghp_abcdefghij1234567890`,
    fingerprint: "abc123def4567890",
    exitState: "crash",
    confidence: "high",
  });
  assert.ok(!payload.error_class.includes("ghp_abcdefghij1234567890"));
});

test("redaction: a KEY=value credential pair embedded in an allowlisted field is stripped", () => {
  const payload = buildProductFaultPayload({
    pipelineVersion: `1.2.3 DATABASE_PASSWORD=hunter2`,
    hostAdapter: "claude",
    stage: "planning",
    errorClass: "TypeError",
    fingerprint: "abc123def4567890",
    exitState: "crash",
    confidence: "high",
  });
  assert.ok(!payload.pipeline_version.includes("hunter2"));
});

test("buildProductFaultPayload: rejects a fingerprint that is not a fixed-length hex string (#502 review 1, a219b412)", () => {
  assert.throws(() => {
    buildProductFaultPayload({
      pipelineVersion: "1.2.3",
      hostAdapter: "claude",
      stage: "planning",
      errorClass: "TypeError",
      fingerprint: "not-a-fingerprint",
      exitState: "crash",
      confidence: "high",
    });
  });
});

test("isValidProductFaultFingerprint: accepts only fixed-length lowercase hex", () => {
  assert.equal(isValidProductFaultFingerprint("abc123def4567890"), true);
  assert.equal(isValidProductFaultFingerprint("abc123"), false, "too short");
  assert.equal(isValidProductFaultFingerprint("ABC123DEF4567890"), false, "uppercase");
  assert.equal(isValidProductFaultFingerprint("../../etc/passwd"), false, "not hex");
});

// ---------------------------------------------------------------------------
// product_fault event shape + separation
// ---------------------------------------------------------------------------

test("emitProductFault: record shape carries schema_version, payload_schema_version, confidence, rationale, fingerprint", async () => {
  const fs: FakeFs = { files: {}, dirs: {}, mtimes: {} };
  const deps = makeRunStoreDeps(fs);
  const classification = classifyProductFault({
    errorClass: "TypeError",
    errorMessage: "boom",
    stage: "planning",
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    signal: { engineCrash: true },
  });
  assert.ok(classification);
  await emitProductFault("/repo/.agent-pipeline/runs/1-x", {
    classification: classification!,
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    stage: "planning",
    errorClass: "TypeError",
  }, deps);
  const lines = (fs.files["/repo/.agent-pipeline/runs/1-x/events.jsonl"] ?? "").trim().split("\n");
  const event = JSON.parse(lines[lines.length - 1]) as ProductFaultEvent;
  assert.equal(event.type, "product_fault");
  assert.equal(typeof event.schema_version, "number");
  assert.equal(event.payload_schema_version, PRODUCT_FAULT_PAYLOAD_SCHEMA_VERSION);
  assert.equal(event.confidence, "high");
  assert.ok(event.rationale.length > 0);
  assert.equal(event.fingerprint, classification!.fingerprint);
});

test("emitProductFault: does not change other event types' schema_version (additive-only union member)", async () => {
  // The event's own schema_version reuses RUN_SCHEMA_VERSION, exactly like
  // papercut/correction_event do — adding this member does not require or
  // imply any change to those other events' shape/version.
  const fs: FakeFs = { files: {}, dirs: {}, mtimes: {} };
  const deps = makeRunStoreDeps(fs);
  const classification = classifyProductFault({
    errorClass: "TypeError",
    errorMessage: "boom",
    stage: "planning",
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    signal: { engineCrash: true },
  });
  await emitProductFault("/repo/.agent-pipeline/runs/1-x", {
    classification: classification!,
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    stage: "planning",
    errorClass: "TypeError",
  }, deps);
  const lines = (fs.files["/repo/.agent-pipeline/runs/1-x/events.jsonl"] ?? "").trim().split("\n");
  const event = JSON.parse(lines[lines.length - 1]) as ProductFaultEvent;
  assert.notEqual(event.type, "correction_event");
  assert.notEqual(event.type, "papercut");
});

// ---------------------------------------------------------------------------
// resolveProductFaultConfig — gh-free, non-throwing
// ---------------------------------------------------------------------------

test("resolveProductFaultConfig: missing pipeline.yml resolves to disabled without throwing", async () => {
  const fs: FakeFs = { files: {}, dirs: {}, mtimes: {} };
  const deps = makeReportDeps({ fs });
  const config = await resolveProductFaultConfig("/repo", deps);
  assert.equal(config.enabled, false);
});

test("resolveProductFaultConfig: enabled:true with intake fields resolves through", async () => {
  const fs: FakeFs = {
    files: {
      "/repo/.github/pipeline.yml":
        "product_fault:\n  enabled: true\n  intake_endpoint: \"https://intake.example.com\"\n  intake_auth_env: \"MY_TOKEN\"\n",
    },
    dirs: {},
    mtimes: {},
  };
  const deps = makeReportDeps({ fs });
  const config = await resolveProductFaultConfig("/repo", deps);
  assert.deepEqual(config, {
    enabled: true,
    intake_endpoint: "https://intake.example.com",
    intake_auth_env: "MY_TOKEN",
  });
});

// ---------------------------------------------------------------------------
// pipeline report: inert by default
// ---------------------------------------------------------------------------

test("runProductFaultReport: absent config performs no network I/O and no gh write", async () => {
  const deps = makeReportDeps({ fs: { files: {}, dirs: {}, mtimes: {} } });
  const result = await runProductFaultReport({ repoDir: "/repo" }, deps);
  assert.equal(result.outcome, "disabled");
  assert.equal(deps.submitCalls.length, 0);
});

test("runProductFaultReport: disabled config performs no submission and informs the operator", async () => {
  const fs: FakeFs = {
    files: { "/repo/.github/pipeline.yml": "product_fault:\n  enabled: false\n" },
    dirs: {},
    mtimes: {},
  };
  const deps = makeReportDeps({ fs });
  const result = await runProductFaultReport({ repoDir: "/repo" }, deps);
  assert.equal(result.outcome, "disabled");
  assert.equal(deps.submitCalls.length, 0);
  assert.ok(deps.logLines.some((l) => l.includes("disabled")));
});

function repoWithFault(faultOverrides: Partial<ProductFaultEvent> = {}): FakeFs {
  const event: ProductFaultEvent = {
    schema_version: 1,
    type: "product_fault",
    at: "2026-07-24T00:00:00Z",
    payload_schema_version: PRODUCT_FAULT_PAYLOAD_SCHEMA_VERSION,
    confidence: "high",
    rationale: "Agent Pipeline crashed with an uncaught TypeError.",
    fingerprint: "abc123def4567890",
    pipeline_version: "1.2.3",
    host_adapter: "claude",
    stage: "planning",
    error_class: "TypeError",
    exit_state: "crash",
    ...faultOverrides,
  };
  return {
    files: {
      "/repo/.github/pipeline.yml": "product_fault:\n  enabled: true\n",
      "/repo/.agent-pipeline/runs/42-2026-07-24T00-00-00-000Z/events.jsonl": `${JSON.stringify(event)}\n`,
    },
    dirs: {
      "/repo/.agent-pipeline/runs": [{ name: "42-2026-07-24T00-00-00-000Z", isDirectory: () => true }],
    },
    mtimes: {
      "/repo/.agent-pipeline/runs/42-2026-07-24T00-00-00-000Z": 1000,
    },
  };
}

test("runProductFaultReport: no product_fault event found -> nothing to report, no network", async () => {
  const fs: FakeFs = {
    files: { "/repo/.github/pipeline.yml": "product_fault:\n  enabled: true\n" },
    dirs: {},
    mtimes: {},
  };
  const deps = makeReportDeps({ fs });
  const result = await runProductFaultReport({ repoDir: "/repo" }, deps);
  assert.equal(result.outcome, "no-fault-found");
  assert.equal(deps.submitCalls.length, 0);
});

/** A dedicated, non-GitHub intake credential env-var name/value used across
 *  the submission tests below — set/restored around each test so the fake
 *  submission path has a valid credential to read via `process.env`. */
const INTAKE_AUTH_ENV_NAME = "PIPELINE_REPORT_TOKEN";
const INTAKE_AUTH_ENV_VALUE = "pfic_v1.product-fault-intake.dedicatedsubmissioncredentialvalue";

function withIntakeAuthEnv(fn: () => Promise<void>): Promise<void> {
  const prior = process.env[INTAKE_AUTH_ENV_NAME];
  process.env[INTAKE_AUTH_ENV_NAME] = INTAKE_AUTH_ENV_VALUE;
  return fn().finally(() => {
    if (prior === undefined) delete process.env[INTAKE_AUTH_ENV_NAME];
    else process.env[INTAKE_AUTH_ENV_NAME] = prior;
  });
}

function withIntake(fs: FakeFs): FakeFs {
  fs.files["/repo/.github/pipeline.yml"] +=
    `  intake_endpoint: "https://intake.example.com"\n  intake_auth_env: "${INTAKE_AUTH_ENV_NAME}"\n`;
  return fs;
}

test("runProductFaultReport: preview is byte-identical to the submitted payload", async () => {
  await withIntakeAuthEnv(async () => {
    const fs = withIntake(repoWithFault());
    const deps = makeReportDeps({ fs, confirmResult: true });
    const result = await runProductFaultReport({ repoDir: "/repo" }, deps);
    assert.equal(result.outcome, "submitted");
    assert.equal(deps.submitCalls.length, 1);
    const submittedBody = deps.submitCalls[0].body;
    assert.equal(submittedBody, renderProductFaultPreview(result.payload));
    const previewLogged = deps.logLines.some((l) => l === submittedBody);
    assert.ok(previewLogged, "the previewed line must equal the exact submitted body");
  });
});

test("runProductFaultReport: no confirmation -> no transmission", async () => {
  await withIntakeAuthEnv(async () => {
    const fs = withIntake(repoWithFault());
    const deps = makeReportDeps({ fs, confirmResult: false });
    const result = await runProductFaultReport({ repoDir: "/repo" }, deps);
    assert.equal(result.outcome, "declined");
    assert.equal(deps.submitCalls.length, 0);
  });
});

test("runProductFaultReport: --yes bypasses the interactive prompt and is treated as explicit confirmation", async () => {
  await withIntakeAuthEnv(async () => {
    const fs = withIntake(repoWithFault());
    const deps = makeReportDeps({ fs, confirmResult: false });
    const result = await runProductFaultReport({ repoDir: "/repo", assumeYes: true }, deps);
    assert.equal(result.outcome, "submitted");
    assert.equal(deps.submitCalls.length, 1);
  });
});

test("runProductFaultReport: submission writes a local audit record with payload hash, destination, timestamp, confirmation", async () => {
  await withIntakeAuthEnv(async () => {
    const fs = withIntake(repoWithFault());
    const deps = makeReportDeps({ fs, confirmResult: true });
    await runProductFaultReport({ repoDir: "/repo" }, deps);
    const auditPath = productFaultAuditLogPath("/repo");
    const lines = (fs.files[auditPath] ?? "").trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.confirmed, true);
    assert.equal(record.destination, "https://intake.example.com");
    assert.ok(record.payload_hash.length > 0);
    assert.ok(record.at.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Intake credential boundary (#502 review 1, finding de283aae): reject a
// GitHub credential variable name, a GitHub-token-shaped value, and a missing
// credential — never forward a GitHub token to a third-party intake endpoint.
// ---------------------------------------------------------------------------

test("runProductFaultReport: refuses submission when intake_auth_env names a GitHub credential variable", async () => {
  const fs = repoWithFault();
  fs.files["/repo/.github/pipeline.yml"] +=
    '  intake_endpoint: "https://intake.example.com"\n  intake_auth_env: "GITHUB_TOKEN"\n';
  const priorGhToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "ghp_realgithubcredential1234567890";
  try {
    const deps = makeReportDeps({ fs, confirmResult: true });
    const result = await runProductFaultReport({ repoDir: "/repo" }, deps);
    assert.equal(result.outcome, "auth-rejected");
    assert.equal(deps.submitCalls.length, 0, "must never forward a GitHub credential to the intake endpoint");
  } finally {
    if (priorGhToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = priorGhToken;
  }
});

test("runProductFaultReport: refuses submission when the intake credential value is GitHub-token-shaped", async () => {
  const fs = repoWithFault();
  fs.files["/repo/.github/pipeline.yml"] +=
    `  intake_endpoint: "https://intake.example.com"\n  intake_auth_env: "${INTAKE_AUTH_ENV_NAME}"\n`;
  const prior = process.env[INTAKE_AUTH_ENV_NAME];
  process.env[INTAKE_AUTH_ENV_NAME] = "ghp_abcdefghij1234567890";
  try {
    const deps = makeReportDeps({ fs, confirmResult: true });
    const result = await runProductFaultReport({ repoDir: "/repo" }, deps);
    assert.equal(result.outcome, "auth-rejected");
    assert.equal(deps.submitCalls.length, 0);
  } finally {
    if (prior === undefined) delete process.env[INTAKE_AUTH_ENV_NAME];
    else process.env[INTAKE_AUTH_ENV_NAME] = prior;
  }
});

test("runProductFaultReport: refuses submission when intake_auth_env is absent", async () => {
  const fs = repoWithFault();
  fs.files["/repo/.github/pipeline.yml"] += '  intake_endpoint: "https://intake.example.com"\n';
  const deps = makeReportDeps({ fs, confirmResult: true });
  const result = await runProductFaultReport({ repoDir: "/repo" }, deps);
  assert.equal(result.outcome, "auth-rejected");
  assert.equal(deps.submitCalls.length, 0);
});

// #502 review 2 finding c6a3fc0131788ba7: a non-GitHub, non-token-shaped
// privileged environment variable (an AWS/npm/etc. secret) must still be
// refused — only a versioned, audience-bound intake credential is accepted,
// never an arbitrary environment variable's value.
test("isValidIntakeSubmissionCredential: rejects arbitrary high-value secrets that aren't GitHub-shaped", () => {
  assert.equal(isValidIntakeSubmissionCredential("AKIAABCDEFGHIJKLMNOP"), false);
  assert.equal(isValidIntakeSubmissionCredential("npm_1234567890abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(isValidIntakeSubmissionCredential("just-some-arbitrary-secret-value"), false);
});

test("isValidIntakeSubmissionCredential: accepts only the versioned, audience-bound intake credential shape", () => {
  assert.equal(isValidIntakeSubmissionCredential(INTAKE_AUTH_ENV_VALUE), true);
  assert.equal(isValidIntakeSubmissionCredential("pfic_v1.other-audience.abcdefghijklmnopqrstuvwx"), false);
  assert.equal(isValidIntakeSubmissionCredential("pfic_v1.product-fault-intake.tooshort"), false);
});

test("runProductFaultReport: refuses submission when intake_auth_env names an arbitrary non-GitHub secret (e.g. an AWS/npm credential)", async () => {
  const fs = repoWithFault();
  fs.files["/repo/.github/pipeline.yml"] +=
    '  intake_endpoint: "https://intake.example.com"\n  intake_auth_env: "AWS_SECRET_ACCESS_KEY"\n';
  const priorAws = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  try {
    const deps = makeReportDeps({ fs, confirmResult: true });
    const result = await runProductFaultReport({ repoDir: "/repo" }, deps);
    assert.equal(result.outcome, "auth-rejected");
    assert.equal(deps.submitCalls.length, 0, "must never forward an arbitrary environment secret to the intake endpoint");
  } finally {
    if (priorAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = priorAws;
  }
});

// #502 review 2 finding d38aeff56469cef8: host_adapter must be derived from
// the closed engine-harness vocabulary, never carried through from an
// arbitrary environment value.
test("isValidHostAdapter: accepts only the closed vocabulary", () => {
  assert.equal(isValidHostAdapter("claude"), true);
  assert.equal(isValidHostAdapter("codex"), true);
  assert.equal(isValidHostAdapter("unknown"), true);
  assert.equal(isValidHostAdapter("/Users/operator/secret-repo-name"), false);
  assert.equal(isValidHostAdapter("some-other-value"), false);
});

test("resolveHostAdapter: collapses an unrecognized PIPELINE_HARNESS value to the bounded 'unknown' fallback", () => {
  assert.equal(resolveHostAdapter({ PIPELINE_HARNESS: "claude" }), "claude");
  assert.equal(resolveHostAdapter({ PIPELINE_HARNESS: "codex" }), "codex");
  assert.equal(resolveHostAdapter({ PIPELINE_HARNESS: "/private/repo-name" }), "unknown");
  assert.equal(resolveHostAdapter({}), "unknown");
});

test("buildProductFaultPayload: rejects a host adapter outside the closed vocabulary", () => {
  assert.throws(() =>
    buildProductFaultPayload({
      pipelineVersion: "1.2.3",
      hostAdapter: "/private/some/repo-path",
      stage: "planning",
      errorClass: "TypeError",
      fingerprint: "abc123def4567890",
      exitState: "crash",
      confidence: "high",
    }),
  );
});

test("runProductFaultReport: no intake configured -> manual fallback draft, no auto-created issue, audit record written", async () => {
  const fs = repoWithFault(); // no intake_endpoint
  const deps = makeReportDeps({ fs, confirmResult: true });
  const result = await runProductFaultReport({ repoDir: "/repo" }, deps);
  assert.equal(result.outcome, "manual-fallback");
  assert.equal(deps.submitCalls.length, 0, "manual fallback must perform no network submission");
  assert.ok(result.draftUrl.startsWith("https://github.com/"));
  const auditPath = productFaultAuditLogPath("/repo");
  const lines = (fs.files[auditPath] ?? "").trim().split("\n");
  const record = JSON.parse(lines[0]);
  assert.equal(record.destination, "manual-fallback");
  assert.equal(record.submitted, false);
});

test("buildManualFallbackDraft: prepares a draft the operator must submit — never an API call to create the issue", () => {
  const payload = buildProductFaultPayload({
    pipelineVersion: "1.2.3",
    hostAdapter: "claude",
    stage: "planning",
    errorClass: "TypeError",
    fingerprint: "abc123def4567890",
    exitState: "crash",
    confidence: "high",
  });
  const draft = buildManualFallbackDraft(payload);
  assert.match(draft.url, /^https:\/\/github\.com\/.+\/issues\/new\?/);
  assert.ok(draft.body.includes(payload.fingerprint));
});

test("writeProductFaultAuditRecord: appends without clobbering a prior record", async () => {
  const fs: FakeFs = { files: {}, dirs: {}, mtimes: {} };
  const deps = makeReportDeps({ fs });
  await writeProductFaultAuditRecord("/repo", {
    schema_version: 1,
    at: "2026-07-24T00:00:00Z",
    fingerprint: "aaa",
    payload_hash: "hash1",
    destination: "manual-fallback",
    confirmed: true,
    submitted: false,
  }, deps);
  await writeProductFaultAuditRecord("/repo", {
    schema_version: 1,
    at: "2026-07-24T01:00:00Z",
    fingerprint: "bbb",
    payload_hash: "hash2",
    destination: "manual-fallback",
    confirmed: true,
    submitted: false,
  }, deps);
  const lines = (fs.files[productFaultAuditLogPath("/repo")] ?? "").trim().split("\n");
  assert.equal(lines.length, 2);
});

// ---------------------------------------------------------------------------
// findLatestProductFault
// ---------------------------------------------------------------------------

test("findLatestProductFault: returns null when no run carries a product_fault event", async () => {
  const fs: FakeFs = {
    files: {},
    dirs: { "/repo/.agent-pipeline/runs": [{ name: "1-x", isDirectory: () => true }] },
    mtimes: { "/repo/.agent-pipeline/runs/1-x": 1 },
  };
  const deps = makeReportDeps({ fs });
  const found = await findLatestProductFault("/repo", deps);
  assert.equal(found, null);
});

test("findLatestProductFault: finds the event when present", async () => {
  const fs = repoWithFault();
  const deps = makeReportDeps({ fs });
  const found = await findLatestProductFault("/repo", deps);
  assert.ok(found);
  assert.equal(found!.type, "product_fault");
  assert.equal(found!.fingerprint, "abc123def4567890");
});

test("isValidProductFaultEvent: rejects a tampered fingerprint, confidence, or exit_state", () => {
  const valid: ProductFaultEvent = {
    schema_version: 1,
    type: "product_fault",
    at: "2026-07-24T00:00:00Z",
    payload_schema_version: PRODUCT_FAULT_PAYLOAD_SCHEMA_VERSION,
    confidence: "high",
    rationale: "Agent Pipeline crashed with an uncaught TypeError.",
    fingerprint: "abc123def4567890",
    pipeline_version: "1.2.3",
    host_adapter: "claude",
    stage: "planning",
    error_class: "TypeError",
    exit_state: "crash",
  };
  assert.equal(isValidProductFaultEvent(valid), true);
  assert.equal(isValidProductFaultEvent({ ...valid, fingerprint: "not-hex" }), false);
  assert.equal(isValidProductFaultEvent({ ...valid, confidence: "critical" as never }), false);
  assert.equal(isValidProductFaultEvent({ ...valid, exit_state: "arbitrary" as never }), false);
  assert.equal(isValidProductFaultEvent({ ...valid, rationale: "" }), false);
});

test("findLatestProductFault: a tampered/malformed persisted event (invalid fingerprint) is rejected rather than reported (#502 review 1, a219b412)", async () => {
  const fs = repoWithFault({ fingerprint: "../../../etc/passwd" });
  const deps = makeReportDeps({ fs });
  const found = await findLatestProductFault("/repo", deps);
  assert.equal(found, null, "a malformed event must never be surfaced for reporting");
});
