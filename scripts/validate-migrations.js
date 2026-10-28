"use strict";

const fs = require("fs");
const path = require("path");

const migrationsDir = path.resolve(__dirname, "..", "supabase", "migrations");
const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const errors = [];
let previous = -1;

for (const file of files) {
  const match = /^(\d+)_([a-z0-9_-]+)\.sql$/i.exec(file);
  if (!match) {
    errors.push(`${file}: filename must start with a numeric sequence and descriptive name`);
    continue;
  }
  const sequence = Number(match[1]);
  if (sequence <= previous) errors.push(`${file}: migration sequence is not strictly increasing`);
  previous = sequence;
  const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
  if (/\bdrop\s+(table|column)\b/i.test(sql) && !/PROPERTY_PORTAL-DESTRUCTIVE-MIGRATION-APPROVED/.test(sql)) {
    errors.push(`${file}: destructive DROP requires PROPERTY_PORTAL-DESTRUCTIVE-MIGRATION-APPROVED and staged expand/contract evidence`);
  }
  if (/security\s+definer/i.test(sql) && !/set\s+search_path/i.test(sql)) {
    errors.push(`${file}: SECURITY DEFINER function must set a safe search_path`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${files.length} migration file(s).`);
}
