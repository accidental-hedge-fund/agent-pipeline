import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname, platform } from "node:os";
import { promisify } from "node:util";
import { canonicalJson } from "./grant.mjs";

const execFileAsync = promisify(execFile);

export const JOURNAL_SCHEMA_VERSION = 1;
const TERMINAL_ACTIVE_STATES = new Set(["completed", "stopped", "revoked", "rolled_back", "failed"]);
const FORBIDDEN_RECORD_KEY = /(secret|token|password|credential|prompt|stdout|stderr|raw_output|environment)/i;

function defaultFsDeps() {
  return {
    readFile: (path) => fs.readFile(path, "utf8"),
    writeFile: (path, body, options) => fs.writeFile(path, body, options),
    rename: (from, to) => fs.rename(from, to),
    mkdir: (path, options) => fs.mkdir(path, options),
    open: (path, flags, mode) => fs.open(path, flags, mode),
    link: (from, to) => fs.link(from, to),
    unlink: (path) => fs.unlink(path),
    syncDirectory: async (path) => {
      const handle = await fs.open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
}

function isMissing(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

function hashName(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function procStartTicks(body) {
  const close = String(body).lastIndexOf(")");
  const fields = close >= 0 ? String(body).slice(close + 1).trim().split(/\s+/) : [];
  const value = fields[19];
  if (!/^[0-9]+$/.test(value ?? "")) throw new Error("process start identity is unavailable");
  return value;
}

async function defaultLockOwner(random) {
  const [bootId, processStart] = await Promise.all([
    currentBootIdentity(),
    processStartIdentity(process.pid),
  ]);
  return {
    schema_version: 1,
    host: hostname(),
    boot_id: bootId,
    pid: process.pid,
    process_start: processStart,
    token: random(),
  };
}

async function defaultLockOwnerStatus(owner) {
  if (!owner || owner.schema_version !== 1 || typeof owner.host !== "string") return "invalid";
  if (owner.host !== hostname()) return "foreign";
  try {
    const bootId = await currentBootIdentity();
    if (owner.boot_id !== bootId) return "dead";
  } catch {
    return "invalid";
  }
  const expectedStart = owner.process_start ?? owner.start_ticks;
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof expectedStart !== "string" || !expectedStart) return "invalid";
  try {
    return await processStartIdentity(owner.pid) === expectedStart ? "alive" : "dead";
  } catch (error) {
    return error?.code === "ENOENT" ? "dead" : "invalid";
  }
}

async function currentBootIdentity() {
  if (platform() === "linux") {
    return (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  }
  if (platform() === "darwin") {
    const { stdout } = await execFileAsync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { env: {} });
    const match = String(stdout).match(/sec\s*=\s*([0-9]+)/);
    if (!match) throw new Error("host boot identity is unavailable");
    return `darwin-${match[1]}`;
  }
  throw new Error(`lock owner identity is unsupported on ${platform()}`);
}

async function processStartIdentity(pid) {
  if (platform() === "linux") {
    return procStartTicks(await fs.readFile(`/proc/${pid}/stat`, "utf8"));
  }
  if (platform() === "darwin") {
    try {
      const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: {} });
      const value = String(stdout).trim().replace(/\s+/g, " ");
      if (!value) {
        const error = new Error("process does not exist");
        error.code = "ENOENT";
        throw error;
      }
      return value;
    } catch (error) {
      if (Number(error?.code) === 1) {
        const missing = new Error("process does not exist");
        missing.code = "ENOENT";
        throw missing;
      }
      throw error;
    }
  }
  throw new Error(`process start identity is unsupported on ${platform()}`);
}

function assertSafeRecord(value, path = "record", depth = 0) {
  if (depth > 8) throw new Error(`${path} is too deeply nested`);
  if (value == null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > 2048) throw new Error(`${path} contains an overlong string`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error(`${path} contains too many array entries`);
    value.forEach((entry, index) => assertSafeRecord(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") throw new Error(`${path} contains an unsupported value`);
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_RECORD_KEY.test(key)) throw new Error(`${path}.${key} is not permitted in the journal`);
    assertSafeRecord(entry, `${path}.${key}`, depth + 1);
  }
}

export function actionId(fingerprint, kind, target) {
  return createHash("sha256")
    .update(canonicalJson({ fingerprint, kind, target }), "utf8")
    .digest("hex");
}

export function journalPaths(stateDir, fingerprint) {
  return {
    run: join(stateDir, "runs", `${fingerprint}.json`),
    active: join(stateDir, "active.json"),
    event: (eventId) => join(stateDir, "bindings", "events", `${hashName(eventId)}.json`),
    nonce: (nonce) => join(stateDir, "bindings", "nonces", `${hashName(nonce)}.json`),
    notices: join(stateDir, "notices.jsonl"),
  };
}

export class JournalStore {
  constructor({
    stateDir,
    fsDeps = defaultFsDeps(),
    now = () => new Date(),
    random = () => randomBytes(8).toString("hex"),
    lockDeps = {},
  }) {
    this.stateDir = stateDir;
    this.fs = fsDeps;
    this.now = now;
    this.random = random;
    this.claimCounter = 0;
    this.saveQueues = new Map();
    this.lockOwner = lockDeps.owner ?? (() => defaultLockOwner(this.random));
    this.lockOwnerStatus = lockDeps.status ?? defaultLockOwnerStatus;
  }

  async acquireExclusiveLock(path, conflictMessage) {
    const owner = await this.lockOwner();
    const create = (target, value) => this.publishExclusive(target, value);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await create(path, owner);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = await this.readJson(path);
        const status = await this.lockOwnerStatus(existing);
        if (status === "alive") throw new Error(conflictMessage);
        if (status === "foreign") throw new Error("refusing to reclaim a lock owned by another host");
        if (status !== "dead") throw new Error("lock owner identity is invalid; refusing unsafe reclaim");
        const recoveryPath = `${path}.recovery`;
        let recovery = false;
        try {
          await create(recoveryPath, owner);
          recovery = true;
        } catch (recoveryError) {
          if (recoveryError?.code !== "EEXIST") throw recoveryError;
          const recoveryOwner = await this.readJson(recoveryPath);
          const recoveryStatus = await this.lockOwnerStatus(recoveryOwner);
          if (recoveryStatus === "dead") {
            await this.fs.unlink(recoveryPath);
            continue;
          }
          throw new Error("lock recovery is already in progress");
        }
        try {
          const current = await this.readJson(path);
          const currentStatus = current ? await this.lockOwnerStatus(current) : "dead";
          if (currentStatus === "foreign") throw new Error("refusing to reclaim a lock owned by another host");
          if (currentStatus === "alive") throw new Error(conflictMessage);
          if (current && currentStatus !== "dead") throw new Error("lock owner identity is invalid; refusing unsafe reclaim");
          await this.fs.unlink(path).catch((unlinkError) => {
            if (unlinkError?.code !== "ENOENT") throw unlinkError;
          });
        } finally {
          if (recovery) await this.fs.unlink(recoveryPath).catch(() => {});
        }
        continue;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const current = await this.readJson(path);
        if (current?.token === owner.token) await this.fs.unlink(path);
      };
    }
    throw new Error("could not acquire the owner-only lock after stale-owner recovery");
  }

  async readJson(path) {
    try {
      return JSON.parse(await this.fs.readFile(path));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async atomicWrite(path, value) {
    assertSafeRecord(value);
    const directory = dirname(path);
    await this.fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}-${this.claimCounter += 1}-${this.random()}`;
    let handle;
    try {
      handle = await this.fs.open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync?.();
      await handle.close();
      handle = null;
      await this.fs.rename(temp, path);
      await this.fs.syncDirectory?.(directory);
    } finally {
      await handle?.close?.().catch(() => {});
      await this.fs.unlink(temp).catch(() => {});
    }
  }

  async publishExclusive(path, value) {
    const directory = dirname(path);
    await this.fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${path}.claim-${process.pid}-${this.claimCounter += 1}-${this.random()}`;
    let handle;
    try {
      handle = await this.fs.open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync?.();
      await handle.close();
      handle = null;
      await this.fs.link(temp, path);
      await this.fs.syncDirectory?.(directory);
    } finally {
      await handle?.close?.().catch(() => {});
      await this.fs.unlink(temp).catch(() => {});
    }
  }

  async bind(path, binding, name) {
    assertSafeRecord(binding);
    try {
      await this.publishExclusive(path, binding);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await this.readJson(path);
      if (
        !existing ||
        existing.fingerprint !== binding.fingerprint ||
        (existing.receipt_hash && binding.receipt_hash && existing.receipt_hash !== binding.receipt_hash)
      ) {
        throw new Error(`${name} is already bound to another grant fingerprint`);
      }
      return;
    }
  }

  async admit(validated) {
    const lockPath = join(this.stateDir, "admission.lock");
    await this.fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const release = await this.acquireExclusiveLock(lockPath, "another grant admission is in progress");
    try {
      return await this.admitUnlocked(validated);
    } finally {
      await release();
    }
  }

  async admitUnlocked(validated) {
    const paths = journalPaths(this.stateDir, validated.fingerprint);
    const binding = {
      schema_version: JOURNAL_SCHEMA_VERSION,
      fingerprint: validated.fingerprint,
      event_id: validated.auth.message_id,
      receipt_hash: validated.fingerprint,
    };
    await this.bind(paths.event(validated.auth.message_id), binding, "Buzz event identity");
    await this.bind(paths.nonce(validated.grant.nonce), binding, "grant nonce");

    const active = await this.readJson(paths.active);
    if (
      active &&
      active.fingerprint !== validated.fingerprint &&
      !TERMINAL_ACTIVE_STATES.has(active.status)
    ) {
      throw new Error(`another grant is active (${active.fingerprint})`);
    }

    let journal = await this.readJson(paths.run);
    if (!journal) {
      const now = this.now().toISOString();
      journal = {
        schema_version: JOURNAL_SCHEMA_VERSION,
        grant_fingerprint: validated.fingerprint,
        grant_event_id: validated.auth.message_id,
        thread_id: validated.auth.thread_id,
        status: "running",
        current: null,
        actions: {},
        notices: {
          last_material_id: null,
          last_material_at: null,
          last_heartbeat_at: null,
          pending: {},
          delivered_ids: [],
        },
        created_at: now,
        updated_at: now,
      };
      await this.atomicWrite(paths.run, journal);
    } else if (
      journal.grant_fingerprint !== validated.fingerprint ||
      journal.grant_event_id !== validated.auth.message_id
    ) {
      throw new Error("stored journal identity does not match the authenticated grant");
    }
    await this.writeActive(journal);
    return journal;
  }

  async acquireRunLease(fingerprint) {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("run lease fingerprint is invalid");
    const directory = join(this.stateDir, "leases");
    const path = join(directory, `${fingerprint}.lock`);
    await this.fs.mkdir(directory, { recursive: true, mode: 0o700 });
    return this.acquireExclusiveLock(path, "another controller owns this grant run");
  }

  async writeActive(journal) {
    const paths = journalPaths(this.stateDir, journal.grant_fingerprint);
    await this.atomicWrite(paths.active, {
      schema_version: JOURNAL_SCHEMA_VERSION,
      fingerprint: journal.grant_fingerprint,
      status: journal.status,
      updated_at: journal.updated_at,
    });
  }

  async save(journal) {
    const key = journal.grant_fingerprint;
    journal.updated_at = this.now().toISOString();
    const snapshot = structuredClone(journal);
    const prior = this.saveQueues.get(key) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(async () => {
      const paths = journalPaths(this.stateDir, snapshot.grant_fingerprint);
      await this.atomicWrite(paths.run, snapshot);
      await this.writeActive(snapshot);
      return journal;
    });
    this.saveQueues.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.saveQueues.get(key) === pending) this.saveQueues.delete(key);
    }
  }

  async getActive() {
    const activePath = join(this.stateDir, "active.json");
    const active = await this.readJson(activePath);
    if (!active) return null;
    return this.readJson(join(this.stateDir, "runs", `${active.fingerprint}.json`));
  }

  async beginAction(journal, kind, target) {
    assertSafeRecord(target, "target");
    const id = actionId(journal.grant_fingerprint, kind, target);
    const existing = journal.actions[id];
    if (existing?.state === "completed") return { id, state: "completed", record: existing };
    if (existing?.state === "running" || existing?.state === "ambiguous") {
      return { id, state: "reconcile", record: existing };
    }
    const now = this.now().toISOString();
    journal.current = { action_id: id, kind, target };
    journal.actions[id] = {
      action_id: id,
      kind,
      target,
      state: "running",
      attempt: (existing?.attempt ?? 0) + 1,
      started_at: now,
      completed_at: null,
      observed: null,
      result: null,
      error: null,
    };
    await this.save(journal);
    return { id, state: "started", record: journal.actions[id] };
  }

  async retryAction(journal, id) {
    const record = journal.actions[id];
    if (!record || !["running", "ambiguous", "failed"].includes(record.state)) {
      throw new Error(`action ${id} is not retryable`);
    }
    record.state = "running";
    record.attempt += 1;
    record.started_at = this.now().toISOString();
    record.completed_at = null;
    record.error = null;
    journal.current = { action_id: id, kind: record.kind, target: record.target };
    await this.save(journal);
  }

  async completeAction(journal, id, result) {
    assertSafeRecord(result, "result");
    const record = journal.actions[id];
    if (!record) throw new Error(`action ${id} does not exist`);
    record.state = "completed";
    record.completed_at = this.now().toISOString();
    record.result = result;
    record.error = null;
    if (journal.current?.action_id === id) journal.current = null;
    await this.save(journal);
    return record;
  }

  async observeAction(journal, id, observed) {
    assertSafeRecord(observed, "observed");
    const record = journal.actions[id];
    if (!record) throw new Error(`action ${id} does not exist`);
    record.observed = { ...(record.observed ?? {}), ...observed };
    await this.save(journal);
  }

  async markAction(journal, id, state, error) {
    if (state !== "failed" && state !== "ambiguous") throw new Error(`invalid action state ${state}`);
    const record = journal.actions[id];
    if (!record) throw new Error(`action ${id} does not exist`);
    record.state = state;
    record.error = String(error).slice(0, 500);
    if (journal.current?.action_id === id) journal.current = null;
    await this.save(journal);
  }

  async markStatus(journal, status) {
    journal.status = status;
    journal.current = null;
    await this.save(journal);
  }

  async recordNotice(journal, kind, id) {
    const now = this.now().toISOString();
    if (kind === "heartbeat") journal.notices.last_heartbeat_at = now;
    else {
      journal.notices.last_material_id = id;
      journal.notices.last_material_at = now;
    }
    await this.save(journal);
  }

  async enqueueNotice(journal, kind, id, notice) {
    assertSafeRecord(notice, "notice");
    journal.notices.pending ??= {};
    journal.notices.delivered_ids ??= [];
    if (journal.notices.delivered_ids.includes(id)) return { state: "delivered", notice };
    const existing = journal.notices.pending[id];
    if (existing) return { state: "pending", kind: existing.kind, notice: existing.notice };
    if (Object.keys(journal.notices.pending).length >= 100) {
      throw new Error("notice outbox reached its bounded pending limit");
    }
    journal.notices.pending[id] = { id, kind, notice };
    await this.save(journal);
    return { state: "pending", kind, notice };
  }

  async completeNotice(journal, kind, id) {
    journal.notices.pending ??= {};
    journal.notices.delivered_ids ??= [];
    delete journal.notices.pending[id];
    journal.notices.delivered_ids = [...journal.notices.delivered_ids.filter((value) => value !== id), id].slice(-100);
    const now = this.now().toISOString();
    if (kind === "heartbeat") journal.notices.last_heartbeat_at = now;
    else {
      journal.notices.last_material_id = id;
      journal.notices.last_material_at = now;
    }
    await this.save(journal);
  }
}
