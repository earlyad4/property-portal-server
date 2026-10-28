"use strict";

const { createClient } = require("@supabase/supabase-js");

const supabaseUrl          = process.env.SUPABASE_URL;
const serviceRoleKey       = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey              = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !serviceRoleKey || !anonKey) {
  throw new Error(
    "SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must be set in .env"
  );
}

// Service-role client — bypasses RLS. NEVER expose to clients.
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Anon client — used to verify tenant JWTs issued by Supabase Auth.
const anon = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = { admin, anon, supabaseUrl, anonKey };
// Default export for backward compatibility
module.exports.default = admin;
module.exports.supabase = admin;
