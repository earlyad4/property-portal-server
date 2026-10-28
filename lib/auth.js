"use strict";

const jwt = require("jsonwebtoken");
const { admin, anon } = require("./supabase");

const JWT_SECRET = process.env.ADMIN_JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("ADMIN_JWT_SECRET must be set in .env");
}

function readBearer(req) {
  const h = req.headers.authorization || "";
  if (!h.toLowerCase().startsWith("bearer ")) return null;
  return h.slice(7).trim() || null;
}

function signAdminToken(adminUser) {
  return jwt.sign(
    { sub: adminUser.id, email: adminUser.email, role: adminUser.role || "admin", kind: "admin" },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

function verifyAdminToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.kind !== "admin") return null;
    return decoded;
  } catch {
    return null;
  }
}

async function requireAdmin(req, res, next) {
  const token = readBearer(req);
  if (!token) return res.status(401).json({ error: "Missing admin token" });

  const decoded = verifyAdminToken(token);
  if (!decoded) return res.status(401).json({ error: "Invalid or expired admin token" });

  const result = await admin
    .from("AdminUser")
    .select("id, email, role, is_active, name")
    .eq("id", decoded.sub)
    .single();

  const row = result.data;
  const err = result.error;

  if (err || !row || !row.is_active) {
    return res.status(401).json({ error: "Admin disabled" });
  }

  req.admin = row;
  next();
}

async function requireTenant(req, res, next) {
  const token = readBearer(req);
  if (!token) return res.status(401).json({ error: "Missing tenant token" });

  const userRes = await anon.auth.getUser(token);
  if (userRes.error || !userRes.data || !userRes.data.user) {
    return res.status(401).json({ error: "Invalid tenant token" });
  }

  const tRes = await admin
    .from("Tenant")
    .select("*")
    .eq("auth_user_id", userRes.data.user.id)
    .single();

  if (tRes.error || !tRes.data) {
    return res.status(403).json({ error: "No tenant profile linked to this account" });
  }
  if (tRes.data.access_disabled_at) {
    return res.status(403).json({ error: "Account access is disabled", code: "ACCOUNT_ACCESS_DISABLED" });
  }

  req.tenant = tRes.data;
  req.authUser = userRes.data.user;
  next();
}

async function requireAnyUser(req, res, next) {
  const token = readBearer(req);
  if (!token) return res.status(401).json({ error: "Missing token" });

  const decoded = verifyAdminToken(token);
  if (decoded) {
    const ar = await admin
      .from("AdminUser").select("id, email, role, is_active, name")
      .eq("id", decoded.sub).single();
    if (ar.data && ar.data.is_active) {
      req.admin = ar.data;
      return next();
    }
  }

  const userRes = await anon.auth.getUser(token);
  if (userRes.error || !userRes.data || !userRes.data.user) {
    return res.status(401).json({ error: "Invalid token" });
  }
  const tr = await admin
    .from("Tenant").select("*").eq("auth_user_id", userRes.data.user.id).single();
  if (!tr.data) return res.status(403).json({ error: "No tenant profile" });
  if (tr.data.access_disabled_at) return res.status(403).json({ error: "Account access is disabled", code: "ACCOUNT_ACCESS_DISABLED" });

  req.tenant = tr.data;
  req.authUser = userRes.data.user;
  next();
}

module.exports = {
  signAdminToken,
  verifyAdminToken,
  requireAdmin,
  requireTenant,
  requireAnyUser,
};
