"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { Client } = require("pg");

const ENCRYPTION_MAGIC = Buffer.from("PROPERTY_PORTAL-BACKUP-V1\n", "utf8");

function isoFileStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseEncryptionKey(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (/^[a-fA-F0-9]{64}$/.test(value)) return Buffer.from(value, "hex");
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

function encryptBuffer(buffer, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENCRYPTION_MAGIC, iv, tag, encrypted]);
}

function decryptBuffer(buffer, key) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, ENCRYPTION_MAGIC.length).equals(ENCRYPTION_MAGIC)) {
    throw new Error("Not a PropertyPortal encrypted backup file");
  }
  const ivStart = ENCRYPTION_MAGIC.length;
  const tagStart = ivStart + 12;
  const dataStart = tagStart + 16;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, buffer.subarray(ivStart, tagStart));
  decipher.setAuthTag(buffer.subarray(tagStart, dataStart));
  return Buffer.concat([decipher.update(buffer.subarray(dataStart)), decipher.final()]);
}

async function writeAtomic(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, data, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function connectDatabase() {
  const candidates = [
    ["direct", process.env.DATABASE_URL],
    ["pooler", process.env.DATABASE_POOLER_URL],
  ].filter(([, url]) => Boolean(url));
  if (!candidates.length) throw new Error("DATABASE_URL or DATABASE_POOLER_URL is required for backups");

  let lastError;
  for (const [label, connectionString] of candidates) {
    const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false";
    const client = new Client({
      connectionString,
      ssl: { rejectUnauthorized },
      connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 8000),
      statement_timeout: Number(process.env.BACKUP_STATEMENT_TIMEOUT_MS || 120000),
      application_name: "property-portal-backup",
    });
    try {
      await client.connect();
      return { client, label };
    } catch (error) {
      lastError = error;
      try { await client.end(); } catch {}
    }
  }
  throw lastError || new Error("Unable to connect to the database");
}

async function listStorageFiles(storage, bucket, prefix = "") {
  const found = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await storage.from(bucket).list(prefix, {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`Storage list failed for ${bucket}/${prefix}: ${error.message}`);
    const entries = data || [];
    for (const entry of entries) {
      const objectPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id || entry.metadata) found.push(objectPath);
      else found.push(...await listStorageFiles(storage, bucket, objectPath));
    }
    if (entries.length < pageSize) break;
  }
  return found;
}

class BackupService {
  constructor({ admin, releaseId }) {
    this.admin = admin;
    this.releaseId = releaseId;
    this.enabled = process.env.BACKUP_ENABLED === "true";
    this.root = path.resolve(process.env.LOCAL_BACKUP_DIR || path.join(__dirname, "..", "runtime-data", "backups"));
    this.cloudBucket = process.env.BACKUP_CLOUD_BUCKET || "property-portal-backups";
    this.sourceBuckets = (process.env.BACKUP_SOURCE_BUCKETS || "building-photos,documents,attachments")
      .split(",").map((v) => v.trim()).filter(Boolean);
    this.key = parseEncryptionKey(process.env.BACKUP_ENCRYPTION_KEY);
    this.running = null;
    this.status = {
      enabled: this.enabled,
      running: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      lastSnapshotId: null,
      localRoot: this.root,
      cloudBucket: this.cloudBucket,
      encrypted: Boolean(this.key),
    };
  }

  getStatus() {
    return { ...this.status, running: Boolean(this.running) };
  }

  async initialize() {
    try {
      const latest = JSON.parse(await fs.readFile(path.join(this.root, "latest.json"), "utf8"));
      this.status.lastSuccessAt = latest.completedAt || null;
      this.status.lastSnapshotId = latest.snapshotId || null;
    } catch (error) {
      if (error.code !== "ENOENT") this.status.lastError = `Unable to read latest backup metadata: ${error.message}`;
    }
    return this.getStatus();
  }

  validateConfiguration() {
    if (!this.enabled) throw new Error("Backups are disabled (set BACKUP_ENABLED=true)");
    if (!this.key) {
      throw new Error("BACKUP_ENCRYPTION_KEY must be a 32-byte base64 value or 64-character hex value");
    }
  }

  async checkLocalTarget() {
    try {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      const probe = path.join(this.root, `.health-${process.pid}-${Date.now()}`);
      await fs.writeFile(probe, "ok", { mode: 0o600 });
      await fs.unlink(probe);
      const statfs = typeof fs.statfs === "function" ? await fs.statfs(this.root) : null;
      return {
        ok: true,
        path: this.root,
        freeBytes: statfs ? Number(statfs.bavail) * Number(statfs.bsize) : null,
      };
    } catch (error) {
      return { ok: false, path: this.root, error: error.message };
    }
  }

  async ensureCloudBucket() {
    const { data, error } = await this.admin.storage.listBuckets();
    if (error) throw new Error(`Unable to list Supabase Storage buckets: ${error.message}`);
    if ((data || []).some((bucket) => bucket.name === this.cloudBucket)) return;
    const created = await this.admin.storage.createBucket(this.cloudBucket, { public: false });
    if (created.error) throw new Error(`Unable to create private backup bucket: ${created.error.message}`);
  }

  async run(reason = "manual") {
    if (this.running) return this.running;
    this.running = this.#run(reason).finally(() => { this.running = null; });
    return this.running;
  }

  async #run(reason) {
    this.validateConfiguration();
    this.status.lastAttemptAt = new Date().toISOString();
    this.status.lastError = null;
    const snapshotId = isoFileStamp();
    const temporaryRoot = path.join(this.root, ".partial", snapshotId);
    const finalRoot = path.join(this.root, snapshotId.slice(0, 4), snapshotId.slice(5, 7), snapshotId);
    const manifest = {
      format: "property-portal-backup-v1",
      snapshotId,
      createdAt: new Date().toISOString(),
      reason,
      releaseId: this.releaseId,
      encrypted: "AES-256-GCM",
      database: { connection: null, tables: [] },
      storage: { buckets: [] },
      files: [],
    };

    try {
      const local = await this.checkLocalTarget();
      if (!local.ok) throw new Error(`Local backup target unavailable: ${local.error}`);
      await fs.rm(temporaryRoot, { recursive: true, force: true });
      await fs.mkdir(temporaryRoot, { recursive: true, mode: 0o700 });

      const { client, label } = await connectDatabase();
      manifest.database.connection = label;
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const tablesResult = await client.query(
          "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name"
        );
        for (const { table_name: tableName } of tablesResult.rows) {
          const rows = await client.query(`select * from public.${quoteIdentifier(tableName)}`);
          const clear = Buffer.from(JSON.stringify({ table: tableName, rows: rows.rows }, null, 2));
          const encrypted = encryptBuffer(clear, this.key);
          const relative = path.join("database", `${safeSegment(tableName)}.json.enc`);
          await writeAtomic(path.join(temporaryRoot, relative), encrypted);
          manifest.database.tables.push({ name: tableName, rows: rows.rowCount });
          manifest.files.push({ path: relative.replaceAll(path.sep, "/"), bytes: encrypted.length, sha256: sha256(encrypted) });
        }
        await client.query("COMMIT");
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
      } finally {
        await client.end();
      }

      const available = await this.admin.storage.listBuckets();
      if (available.error) throw new Error(`Unable to list source buckets: ${available.error.message}`);
      const availableNames = new Set((available.data || []).map((bucket) => bucket.name));
      for (const bucket of this.sourceBuckets) {
        if (!availableNames.has(bucket)) {
          manifest.storage.buckets.push({ name: bucket, status: "not_found", objects: 0 });
          continue;
        }
        const objects = await listStorageFiles(this.admin.storage, bucket);
        const bucketRecord = { name: bucket, status: "backed_up", objects: 0 };
        manifest.storage.buckets.push(bucketRecord);
        for (const objectPath of objects) {
          const downloaded = await this.admin.storage.from(bucket).download(objectPath);
          if (downloaded.error) throw new Error(`Download failed for ${bucket}/${objectPath}: ${downloaded.error.message}`);
          const clear = Buffer.from(await downloaded.data.arrayBuffer());
          const encrypted = encryptBuffer(clear, this.key);
          const relative = path.join("storage", safeSegment(bucket), ...objectPath.split("/").map(safeSegment)) + ".enc";
          await writeAtomic(path.join(temporaryRoot, relative), encrypted);
          manifest.files.push({ path: relative.replaceAll(path.sep, "/"), bytes: encrypted.length, sha256: sha256(encrypted) });
          bucketRecord.objects += 1;
        }
      }

      manifest.completedAt = new Date().toISOString();
      manifest.fileCount = manifest.files.length;
      const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));
      await writeAtomic(path.join(temporaryRoot, "manifest.json"), manifestBuffer);
      await fs.mkdir(path.dirname(finalRoot), { recursive: true, mode: 0o700 });
      await fs.rename(temporaryRoot, finalRoot);
      await writeAtomic(path.join(this.root, "latest.json"), Buffer.from(JSON.stringify({
        snapshotId,
        completedAt: manifest.completedAt,
        relativePath: path.relative(this.root, finalRoot).replaceAll(path.sep, "/"),
        manifestSha256: sha256(manifestBuffer),
      }, null, 2)));

      await this.ensureCloudBucket();
      for (const file of [...manifest.files, { path: "manifest.json" }]) {
        const localPath = path.join(finalRoot, ...file.path.split("/"));
        const body = await fs.readFile(localPath);
        const cloudPath = `snapshots/${snapshotId}/${file.path}`;
        const uploaded = await this.admin.storage.from(this.cloudBucket).upload(cloudPath, body, {
          contentType: file.path.endsWith(".json") ? "application/json" : "application/octet-stream",
          upsert: false,
        });
        if (uploaded.error) throw new Error(`Cloud mirror failed for ${cloudPath}: ${uploaded.error.message}`);
      }
      const latestBody = Buffer.from(JSON.stringify({ snapshotId, completedAt: manifest.completedAt }, null, 2));
      const latestUpload = await this.admin.storage.from(this.cloudBucket).upload("latest.json", latestBody, {
        contentType: "application/json",
        upsert: true,
      });
      if (latestUpload.error) throw new Error(`Cloud latest pointer failed: ${latestUpload.error.message}`);

      this.status.lastSuccessAt = manifest.completedAt;
      this.status.lastSnapshotId = snapshotId;
      return { ok: true, snapshotId, completedAt: manifest.completedAt, fileCount: manifest.fileCount };
    } catch (error) {
      this.status.lastFailureAt = new Date().toISOString();
      this.status.lastError = error.message;
      try { await fs.rm(temporaryRoot, { recursive: true, force: true }); } catch {}
      throw error;
    }
  }
}

module.exports = {
  BackupService,
  decryptBuffer,
  encryptBuffer,
  parseEncryptionKey,
  sha256,
};
