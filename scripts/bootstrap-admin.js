"use strict";

// Creates the first admin operator account from OPERATOR_BOOTSTRAP_PASSWORD in .env.
// Usage: node scripts/bootstrap-admin.js [email] [name]
// Defaults: email=operator@example.com, name="Operator"

require("dotenv").config();
const bcrypt = require("bcryptjs");
const { admin } = require("../lib/supabase");

async function main() {
  const password = process.env.OPERATOR_BOOTSTRAP_PASSWORD;
  if (!password || password.length < 8) {
    console.error("\u2716 OPERATOR_BOOTSTRAP_PASSWORD is missing or too short (min 8 chars).");
    process.exit(1);
  }

  const email = (process.argv[2] || process.env.OPERATOR_BOOTSTRAP_EMAIL || "operator@example.com").toLowerCase();
  const name  = process.argv[3] || process.env.OPERATOR_BOOTSTRAP_NAME || "Operator";

  // Check whether an admin with this email already exists.
  const existingRes = await admin
    .from("AdminUser")
    .select("id, email")
    .eq("email", email)
    .maybeSingle();

  if (existingRes.error && existingRes.error.code !== "PGRST116") {
    console.error("\u2716 Lookup failed:", existingRes.error.message);
    process.exit(1);
  }
  if (existingRes.data) {
    console.log(`\u2713 Admin already exists: ${existingRes.data.email}`);
    console.log("  (If you forgot the password, delete the row in the Supabase AdminUser table and re-run.)");
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  const insertRes = await admin
    .from("AdminUser")
    .insert({
      email,
      name,
      password_hash: hash,
      role: "admin",
      is_active: true,
    })
    .select("id, email, name, role")
    .single();

  if (insertRes.error) {
    console.error("\u2716 Failed to create admin:", insertRes.error.message);
    process.exit(1);
  }

  console.log(`\u2713 Admin created: ${insertRes.data.email} (${insertRes.data.id})`);
  console.log("  Sign in from the desktop app with this email and the password you set");
  console.log("  in OPERATOR_BOOTSTRAP_PASSWORD. You can now remove that value from .env.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
