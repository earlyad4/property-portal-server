"use strict";

// Applies /supabase/migrations/*.sql to the Supabase database in filename order.
//
// Connection strategy:
//   1. Try DATABASE_URL (direct, port 5432) — fails on many home networks / IPv6-only hosts.
//   2. Fall back to DATABASE_POOLER_URL (pooler, port 6543) — works everywhere.
//
// If you hit errors like "already exists", just re-run: each statement is either
// wrapped in IF NOT EXISTS (for tables/indexes) or DROP POLICY IF EXISTS (for policies),
// so the migrations are idempotent. Unknown errors are reported but the script continues
// unless --strict is passed.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const STRICT = process.argv.includes("--strict");

async function connect() {
  const candidates = [
    { label: "direct",  url: process.env.DATABASE_URL },
    { label: "pooler", url: process.env.DATABASE_POOLER_URL },
  ].filter((c) => c.url);

  if (!candidates.length) {
    throw new Error("Neither DATABASE_URL nor DATABASE_POOLER_URL is set in .env.");
  }

  let lastErr = null;
  for (const { label, url } of candidates) {
    const client = new Client({
      connectionString: url,
      ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" },
      connectionTimeoutMillis: 10_000,
    });
    try {
      await client.connect();
      console.log(`✓ Connected to Supabase via ${label} connection.`);
      return client;
    } catch (err) {
      console.warn(`⚠  ${label} connection failed: ${err.code || ""} ${err.message}`);
      try { await client.end(); } catch (_) {}
      lastErr = err;
    }
  }
  throw lastErr || new Error("Could not connect to the database.");
}

function isIgnorableError(err) {
  // Postgres error codes we consider safe to skip when re-running migrations:
  //   42P07 duplicate_table       42710 duplicate_object (e.g. policy)
  //   42701 duplicate_column      42723 duplicate_function
  //   42P06 duplicate_schema      42P04 duplicate_database
  const code = err && err.code;
  return ["42P07", "42710", "42701", "42723", "42P06", "42P04"].includes(code);
}

async function main() {
  const migrationsDir = path.resolve(__dirname, "..", "supabase", "migrations");
  if (!fs.existsSync(migrationsDir)) {
    console.error("✖ migrations directory missing:", migrationsDir);
    process.exit(1);
  }
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.toLowerCase().endsWith(".sql"))
    .sort();
  if (!files.length) {
    console.log("No migrations to apply.");
    return;
  }

  const client = await connect();
  try {
    for (const f of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, f), "utf8");
      console.log(`→ Applying ${f} …`);
      try {
        await client.query(sql);
        console.log(`  ✓ ${f}`);
      } catch (err) {
        if (!STRICT && isIgnorableError(err)) {
          console.warn(`  ⤶  ${f}: ${err.message} (ignored — object already exists)`);
          continue;
        }
        console.error(`  ✖ ${f} failed:`);
        console.error(`    ${err.code || ""} ${err.message}`);
        if (err.hint)   console.error(`    hint: ${err.hint}`);
        if (err.detail) console.error(`    detail: ${err.detail}`);
        console.error("\n  Tip: if you already ran this migration by pasting it into the Supabase SQL editor,");
        console.error("       you can skip it. The server and apps will work as long as the schema is in place.");
        process.exit(1);
      }
    }
    console.log("\n✓ All migrations applied.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
