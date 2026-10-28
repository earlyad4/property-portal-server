"use strict";

require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const { decryptBuffer, parseEncryptionKey, sha256 } = require("../lib/backup-service");

function verificationAlerts() {
  const { admin } = require("../lib/supabase");
  const { AlertService } = require("../lib/alert-service");
  return new AlertService({
    admin,
    environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
    releaseId: process.env.RELEASE_ID || process.env.GIT_SHA || "backup-verifier-local",
  });
}

async function main() {
  const root = path.resolve(process.env.LOCAL_BACKUP_DIR || path.join(__dirname, "..", "runtime-data", "backups"));
  const key = parseEncryptionKey(process.env.BACKUP_ENCRYPTION_KEY);
  if (!key) throw new Error("BACKUP_ENCRYPTION_KEY is invalid or missing");
  const latest = JSON.parse(await fs.readFile(path.join(root, "latest.json"), "utf8"));
  const snapshotRoot = path.join(root, ...latest.relativePath.split("/"));
  const manifestBuffer = await fs.readFile(path.join(snapshotRoot, "manifest.json"));
  if (sha256(manifestBuffer) !== latest.manifestSha256) throw new Error("Manifest checksum mismatch");
  const manifest = JSON.parse(manifestBuffer.toString("utf8"));

  let verified = 0;
  for (const file of manifest.files) {
    const encrypted = await fs.readFile(path.join(snapshotRoot, ...file.path.split("/")));
    if (sha256(encrypted) !== file.sha256) throw new Error(`Checksum mismatch: ${file.path}`);
    decryptBuffer(encrypted, key);
    verified += 1;
  }
  console.log(JSON.stringify({
    ok: true,
    snapshotId: manifest.snapshotId,
    createdAt: manifest.createdAt,
    completedAt: manifest.completedAt,
    filesVerified: verified,
    databaseTables: manifest.database.tables.length,
    storageBuckets: manifest.storage.buckets,
  }, null, 2));
  await verificationAlerts().recover("backup:verification", { summary: `Backup ${manifest.snapshotId} verification passed`, filesVerified: verified }).catch(() => {});
}

main().catch(async (error) => {
  console.error(`Backup verification failed: ${error.message}`);
  await verificationAlerts().createIncident({
    incidentKey: "backup:verification",
    eventType: "backup-verification-failed",
    severity: "critical",
    component: "Backup verification",
    summary: error.message,
    details: { summary: error.message },
    recommendedAction: "Stop relying on the affected snapshot, inspect checksums and encryption configuration, create a new backup, and perform a restore drill.",
    healthStatus: "degraded",
  }).catch(() => {});
  process.exitCode = 1;
});
