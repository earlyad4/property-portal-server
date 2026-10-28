"use strict";

require("dotenv").config();
const { admin } = require("../lib/supabase");
const { BackupService } = require("../lib/backup-service");
const packageJson = require("../package.json");

async function main() {
  const releaseId = process.env.RELEASE_ID || process.env.GIT_SHA || `property-portal-${packageJson.version}-local`;
  const service = new BackupService({ admin, releaseId });
  await service.initialize();
  const result = await service.run("command-line");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`Backup failed: ${error.message}`);
  process.exitCode = 1;
});
