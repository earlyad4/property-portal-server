"use strict";

require("dotenv").config();

const http       = require("http");
const crypto     = require("crypto");
const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const bcrypt     = require("bcryptjs");
const { WebSocketServer } = require("ws");

const { admin, anon } = require("./lib/supabase");
const {
  signAdminToken,
  requireAdmin,
  requireTenant,
  requireAnyUser,
} = require("./lib/auth");
const { buildMaintenanceReport } = require("./lib/analytics");
const {
  ticketsToExcel, ticketsToPdf,
  maintenanceReportToExcel, maintenanceReportToPdf,
  tenantProfileToExcel, tenantProfileToPdf,
} = require("./lib/exporters");
const { getPushStatus, sendExpoPush } = require("./lib/push");
const registerUnitsRosterRoutes = require("./routes/units-roster");
const { BackupService } = require("./lib/backup-service");
const { OperationsService } = require("./lib/operations-service");
const { AlertService } = require("./lib/alert-service");
const { versionBelow } = require("./lib/client-version");
const { markRunning, markStopped } = require("./lib/runtime-state");
const packageJson = require("./package.json");

const PORT = Number(process.env.SERVER_PORT || 4317);
const ENVIRONMENT = process.env.APP_ENV || process.env.NODE_ENV || "development";
const RELEASE_ID = process.env.RELEASE_ID || process.env.GIT_SHA || `property-portal-${packageJson.version}-local`;
const app = express();
const httpServer = http.createServer(app);
let shuttingDown = false;
let inFlightRequests = 0;

// ---------- security middleware ----------

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));

const origins = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origins.length === 0) return ENVIRONMENT === "production" ? cb(new Error("CORS origins are not configured")) : cb(null, true);
    if (origins.includes(origin)) return cb(null, true);
    if (ENVIRONMENT !== "production" && /^https?:\/\/(192\.168|10|172\.(1[6-9]|2\d|3[0-1])|127\.0\.0\.1|localhost)/.test(origin)) {
      return cb(null, true);
    }
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: false,
}));

app.use(express.json({
  limit: "20mb",
  verify: (req, _res, buffer) => {
    if (req.originalUrl === "/api/operations/resend/webhook") req.rawBody = buffer.toString("utf8");
  },
}));

app.use((req, res, next) => {
  const requestId = req.headers["x-request-id"] || crypto.randomUUID();
  req.requestId = String(requestId);
  res.setHeader("x-request-id", req.requestId);
  if (shuttingDown && !req.path.startsWith("/api/health/live")) {
    res.setHeader("connection", "close");
    return res.status(503).json({ error: "Server is shutting down", requestId: req.requestId });
  }
  inFlightRequests += 1;
  let finished = false;
  const complete = () => {
    if (finished) return;
    finished = true;
    inFlightRequests = Math.max(0, inFlightRequests - 1);
  };
  res.once("finish", complete);
  res.once("close", complete);
  next();
});

app.use("/api", (req, res, next) => {
  const client = String(req.get("x-property-portal-client") || "").toLowerCase();
  const minimum = client === "desktop" ? process.env.MIN_DESKTOP_VERSION : client === "mobile" ? process.env.MIN_MOBILE_VERSION : null;
  if (minimum && versionBelow(req.get("x-property-portal-version"), minimum)) {
    return res.status(426).json({
      error: "This PropertyPortal version is no longer supported. Update before continuing.",
      code: "CLIENT_UPGRADE_REQUIRED", client, minimumVersion: minimum, releaseId: RELEASE_ID,
    });
  }
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true });

// ---------- helpers ----------

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}
function now() { return new Date().toISOString(); }

function withTimeline(request) {
  if (!request) return null;
  const timeline = (request.TicketMessage || []).sort((a, b) => new Date(a.at) - new Date(b.at));
  const { TicketMessage, ...rest } = request;
  return { ...rest, timeline };
}

function asyncWrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(err => {
    console.error(err);
    res.status(500).json({ error: err?.message || "Server error" });
  });
}

// ---------- realtime (chat) ----------

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
const wsClients = new Set();
const backupService = new BackupService({ admin, releaseId: RELEASE_ID });
const alertService = new AlertService({ admin, environment: ENVIRONMENT, releaseId: RELEASE_ID });
const operations = new OperationsService({
  admin,
  supabaseUrl: process.env.SUPABASE_URL,
  backupService,
  alertService,
  releaseId: RELEASE_ID,
  environment: ENVIRONMENT,
  getWebSocketCount: () => wsClients.size,
  getPushStatus,
});

wss.on("error", (error) => {
  console.error("[websocket] server error:", error.message);
});

app.use(operations.requestMetricsMiddleware());

wss.on("connection", (socket, req) => {
  const info = { socket, kind: null, id: null, rooms: new Set() };
  wsClients.add(info);

  socket.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "auth") {
      handleWsAuth(info, msg).catch(err => socket.send(JSON.stringify({ type: "error", error: err.message })));
    } else if (msg.type === "subscribe") {
      authorizeWsRoom(info, msg.room).then((allowed) => {
        if (allowed) info.rooms.add(msg.room);
        else socket.send(JSON.stringify({ type: "error", error: "Room access denied" }));
      }).catch(() => socket.send(JSON.stringify({ type: "error", error: "Room access denied" })));
    } else if (msg.type === "unsubscribe") {
      info.rooms.delete(msg.room);
    }
  });

  socket.on("close", () => wsClients.delete(info));
  socket.on("error", () => wsClients.delete(info));
});

async function handleWsAuth(info, msg) {
  if (msg.kind === "admin") {
    const { verifyAdminToken } = require("./lib/auth");
    const decoded = verifyAdminToken(msg.token);
    if (!decoded) throw new Error("Invalid admin token");
    info.kind = "admin"; info.id = decoded.sub;
  } else if (msg.kind === "tenant") {
    const { data } = await anon.auth.getUser(msg.token);
    if (!data?.user) throw new Error("Invalid tenant token");
    const { ["data"]: tenant } = await admin.from("Tenant").select("id, access_disabled_at").eq("auth_user_id", data.user.id).single();
    if (!tenant) throw new Error("No tenant profile");
    if (tenant.access_disabled_at) throw new Error("Account access is disabled");
    info.kind = "tenant"; info.id = tenant.id;
  } else {
    throw new Error("Unknown auth kind");
  }
  info.socket.send(JSON.stringify({ type: "auth:ok", kind: info.kind, id: info.id }));
}

async function authorizeWsRoom(info, room) {
  if (!info.kind || typeof room !== "string" || room.length > 160) return false;
  if (info.kind === "admin") {
    return room === "admin" || /^ticket:[a-zA-Z0-9_-]+$/.test(room) || /^building:[a-zA-Z0-9_-]+$/.test(room);
  }
  if (info.kind !== "tenant" || !room.startsWith("ticket:")) return false;
  const ticketId = room.slice(7);
  const result = await admin.from("MaintenanceRequest").select("id").eq("id", ticketId).eq("tenantId", info.id).maybeSingle();
  return Boolean(result.data);
}

function wsBroadcast(room, event, data, filter) {
  const payload = JSON.stringify({ event, room, data });
  for (const c of wsClients) {
    if (c.socket.readyState !== 1) continue;
    if (filter && !filter(c)) continue;
    if (room && !c.rooms.has(room) && !c.rooms.has("*")) continue;
    c.socket.send(payload);
  }
}

// ---------- health and operations ----------

app.get("/api/health/live", (_req, res) => res.json({
  ok: !shuttingDown,
  status: shuttingDown ? "shutting_down" : "alive",
  checkedAt: now(),
  environment: ENVIRONMENT,
  releaseId: RELEASE_ID,
}));

async function readinessResponse(_req, res) {
  const report = await operations.checks();
  const publicReport = {
    ok: report.ready,
    status: report.status,
    checkedAt: report.checkedAt,
    environment: report.environment,
    releaseId: report.releaseId,
    services: Object.fromEntries(Object.entries(report.services).map(([name, value]) => [name, {
      ok: value.ok,
      latencyMs: value.latencyMs,
    }])),
  };
  res.status(report.ready ? 200 : 503).json(publicReport);
}

app.get("/api/health", asyncWrap(readinessResponse));
app.get("/api/health/ready", asyncWrap(readinessResponse));
app.get("/api/version", (_req, res) => res.json({
  releaseId: RELEASE_ID,
  minimumDesktopVersion: process.env.MIN_DESKTOP_VERSION || null,
  minimumMobileVersion: process.env.MIN_MOBILE_VERSION || null,
}));

app.get("/api/operations/health", requireAdmin, asyncWrap(async (_req, res) => {
  res.setHeader("cache-control", "no-store");
  res.json(await operations.checks({ detailed: true }));
}));

app.post("/api/operations/backups", requireAdmin, asyncWrap(async (req, res) => {
  const result = await backupService.run(`manual:${req.admin.id}`);
  res.status(201).json(result);
}));

app.post("/api/operations/alerts/test", requireAdmin, asyncWrap(async (req, res) => {
  const result = await operations.sendAlert({
    incidentKey: `test:${crypto.randomUUID()}`,
    event: "notification-test",
    severity: "info",
    component: "Alert email delivery",
    requestedBy: req.admin.id,
    message: "Real PropertyPortal operational alert email delivery test",
    healthStatus: operations.lastReport?.status || "unknown",
    force: true,
  });
  res.status(202).json(result);
}));

app.get("/api/operations/alerts", requireAdmin, asyncWrap(async (req, res) => {
  res.setHeader("cache-control", "no-store");
  res.json({ alerts: await alertService.listRecent(req.query.limit) });
}));

app.post("/api/operations/alerts/:id/acknowledge", requireAdmin, asyncWrap(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid alert ID" });
  res.json({ alert: await alertService.acknowledge(req.params.id, req.admin.id, req.body?.note) });
}));

app.post("/api/operations/resend/webhook", async (req, res) => {
  try {
    const result = await alertService.processWebhook(req.rawBody || "", {
      id: req.get("svix-id"), timestamp: req.get("svix-timestamp"), signature: req.get("svix-signature"),
    });
    res.status(200).json({ ok: true, ...result });
  } catch {
    res.status(400).json({ error: "Invalid Resend webhook" });
  }
});

// ---------- AUTH: admin ----------

app.post("/api/auth/admin/login", authLimiter, asyncWrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });

  const { ["data"]: row } = await admin.from("AdminUser").select("*").eq("email", String(email).toLowerCase()).single();
  if (!row || !row.is_active) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  await admin.from("AdminUser").update({ last_login_at: now() }).eq("id", row.id);
  const token = signAdminToken(row);
  res.json({
    token,
    admin: { id: row.id, email: row.email, name: row.name, role: row.role },
  });
}));

app.post("/api/auth/admin/change-password", requireAdmin, asyncWrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "currentPassword and newPassword (min 8) required" });
  }
  const { ["data"]: row } = await admin.from("AdminUser").select("*").eq("id", req.admin.id).single();
  const ok = await bcrypt.compare(currentPassword, row.password_hash);
  if (!ok) return res.status(401).json({ error: "Current password incorrect" });
  const hash = await bcrypt.hash(newPassword, 12);
  await admin.from("AdminUser").update({ password_hash: hash }).eq("id", row.id);
  res.json({ ok: true });
}));

app.get("/api/auth/admin/me", requireAdmin, (req, res) => res.json({ admin: req.admin }));

// ---------- AUTH: tenant ----------

app.get("/api/public/buildings", asyncWrap(async (_req, res) => {
  const { data } = await admin.from("Building").select("id, name, code, address").order("name");
  res.json({ buildings: data || [] });
}));

app.post("/api/auth/tenant/register", authLimiter, asyncWrap(async (req, res) => {
  const { name, email, password, phone, buildingId, unit } = req.body || {};
  if (!name || !email || !password || !buildingId || !unit) {
    return res.status(400).json({ error: "name, email, password, buildingId, unit required" });
  }
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const { ["data"]: b } = await admin.from("Building").select("id").eq("id", buildingId).single();
  if (!b) return res.status(400).json({ error: "Unknown building" });

  const { ["data"]: existing } = await admin.from("Tenant").select("id").eq("email", email).maybeSingle?.() || { ["data"]: null };
  if (existing) return res.status(409).json({ error: "A tenant with this email already exists" });

  const { ["data"]: userRes, error: userErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    ["user_metadata"]: { name, role: "tenant" },
  });
  if (userErr || !userRes?.user) return res.status(400).json({ error: userErr?.message || "Auth creation failed" });

  const tenantId = `TEN-${Date.now().toString(36).toUpperCase()}`;
  const { ["data"]: tenant, error: tErr } = await admin.from("Tenant").insert({
    id: tenantId,
    auth_user_id: userRes.user.id,
    name, email,
    phone: phone || "",
    unit,
    buildingId,
    is_verified: false,
  }).select("*").single();

  if (tErr) {
    await admin.auth.admin.deleteUser(userRes.user.id).catch(() => {});
    return res.status(500).json({ error: tErr.message });
  }

  const { ["data"]: session, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr) return res.status(500).json({ error: "Registered, but sign-in failed: " + sErr.message });

  res.status(201).json({
    tenant,
    accessToken: session.session.access_token,
    refreshToken: session.session.refresh_token,
    expiresAt: session.session.expires_at,
    session: { access_token: session.session.access_token, refresh_token: session.session.refresh_token, expires_at: session.session.expires_at },
  });
}));

app.post("/api/auth/tenant/login", authLimiter, asyncWrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });

  const { ["data"]: session, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });

  const { ["data"]: tenant } = await admin.from("Tenant").select("*").eq("auth_user_id", session.user.id).single();
  if (!tenant) return res.status(403).json({ error: "No tenant profile linked to this account" });

  if (tenant.access_disabled_at || (tenant.deletion_scheduled_for && new Date(tenant.deletion_scheduled_for).getTime() <= Date.now())) {
    if (!tenant.access_disabled_at) {
      await admin.from("Tenant").update({ access_disabled_at: now() }).eq("id", tenant.id);
    }
    const banned = await admin.auth.admin.updateUserById(session.user.id, { ban_duration: "876000h" });
    if (banned.error) throw new Error("Account access was disabled, but Supabase Auth ban failed");
    return res.status(403).json({ error: "Account access was disabled after the 30-day deletion period. Operational property and maintenance records were retained.", code: "ACCOUNT_ACCESS_DISABLED" });
  }

  let deletionRequestCancelled = false;
  if (tenant.deletion_scheduled_for) {
    deletionRequestCancelled = true;
    await admin.from("Tenant").update({ deletion_requested_at: null, deletion_scheduled_for: null, deletion_cancelled_at: now() }).eq("id", tenant.id);
    tenant.deletion_requested_at = null;
    tenant.deletion_scheduled_for = null;
  }

  res.json({
    tenant,
    deletionRequestCancelled,
    accessToken: session.session.access_token,
    refreshToken: session.session.refresh_token,
    expiresAt: session.session.expires_at,
    session: {
      access_token: session.session.access_token,
      refresh_token: session.session.refresh_token,
      expires_at: session.session.expires_at,
    },
  });
}));

app.post("/api/auth/tenant/refresh", asyncWrap(async (req, res) => {
  const { refresh_token } = req.body || {};
  if (!refresh_token) return res.status(400).json({ error: "refresh_token required" });
  const { data, error } = await anon.auth.refreshSession({ refresh_token });
  if (error) return res.status(401).json({ error: error.message });
  res.json({
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    },
  });
}));

app.get("/api/auth/tenant/me", requireTenant, async (req, res) => {
  const { ["data"]: building } = await admin.from("Building").select("*").eq("id", req.tenant.buildingId).single();
  res.json({ tenant: req.tenant, building });
});

app.get("/api/auth/tenant/account-deletion", requireTenant, (req, res) => {
  res.setHeader("cache-control", "no-store");
  res.json({
    requestedAt: req.tenant.deletion_requested_at || null,
    scheduledFor: req.tenant.deletion_scheduled_for || null,
    accessDisabledAt: req.tenant.access_disabled_at || null,
    recordsRetained: true,
  });
});

app.post("/api/auth/tenant/account-deletion", requireTenant, asyncWrap(async (req, res) => {
  if (req.body?.confirmation !== "DELETE MY ACCOUNT") {
    return res.status(400).json({ error: "Exact confirmation is required" });
  }
  const requestedAt = now();
  const scheduledFor = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const result = await admin.from("Tenant").update({
    deletion_requested_at: requestedAt,
    deletion_scheduled_for: scheduledFor,
    deletion_cancelled_at: null,
  }).eq("id", req.tenant.id).select("id, deletion_requested_at, deletion_scheduled_for").single();
  if (result.error) throw result.error;
  res.status(202).json({
    requestedAt, scheduledFor, recordsRetained: true,
    message: "Account access will be disabled after 30 days. Signing in before that date cancels this request. Property and maintenance records are retained.",
  });
}));

app.delete("/api/auth/tenant/account-deletion", requireTenant, asyncWrap(async (req, res) => {
  const result = await admin.from("Tenant").update({
    deletion_requested_at: null,
    deletion_scheduled_for: null,
    deletion_cancelled_at: now(),
  }).eq("id", req.tenant.id).select("id").single();
  if (result.error) throw result.error;
  res.json({ cancelled: true });
}));

// ---------- MOBILE API (tenant-scoped) ----------

app.get("/api/mobile/bootstrap", requireTenant, asyncWrap(async (req, res) => {
  const tenant = req.tenant;

  const [
    { ["data"]: building },
    { ["data"]: requests },
    { ["data"]: documents },
    { ["data"]: qualityReports },
    { ["data"]: reviews },
    { ["data"]: broadcasts },
  ] = await Promise.all([
    admin.from("Building").select("*").eq("id", tenant.buildingId).single(),
    admin.from("MaintenanceRequest").select("*, TicketMessage(*)").eq("tenantId", tenant.id).order("submittedAt", { ascending: false }),
    admin.from("Document").select("*").eq("tenantId", tenant.id).order("submittedAt", { ascending: false }),
    admin.from("QualityReport").select("*").eq("tenantId", tenant.id).order("submittedAt", { ascending: false }),
    admin.from("Review").select("*").eq("tenantId", tenant.id).order("createdAt", { ascending: false }),
    admin.from("Broadcast").select("*").eq("buildingId", tenant.buildingId).order("createdAt", { ascending: false }).limit(20),
  ]);

  res.json({
    tenant,
    building: building || null,
    maintenanceRequests: (requests || []).map(withTimeline),
    documents: documents || [],
    qualityReports: qualityReports || [],
    reviews: reviews || [],
    broadcasts: broadcasts || [],
  });
}));

app.post("/api/mobile/push-token", requireTenant, asyncWrap(async (req, res) => {
  const { pushToken } = req.body || {};
  await admin.from("Tenant").update({ push_token: pushToken || null }).eq("id", req.tenant.id);
  res.json({ ok: true });
}));

app.post("/api/mobile/maintenance-requests", requireTenant, asyncWrap(async (req, res) => {
  const { category, location, description, preferredTime, attachments } = req.body || {};
  if (!category || !description) return res.status(400).json({ error: "category and description required" });

  const record = {
    id: uid("MNT"),
    tenantId: req.tenant.id,
    tenantName: req.tenant.name,
    buildingId: req.tenant.buildingId,
    unit: req.tenant.unit,
    category, title: (description.split(".")[0] || `${category} request`).slice(0, 80),
    location: location || "",
    description,
    status: "Pending",
    preferredTime: preferredTime || "",
    attachments: Number(attachments) || 0,
    submittedAt: now(),
    slaHours: 48,
  };

  const { error } = await admin.from("MaintenanceRequest").insert(record);
  if (error) return res.status(500).json({ error: error.message });

  const msg = { id: uid("TL"), requestId: record.id, author: "PropertyPortal", author_kind: "system", message: "Request submitted successfully.", at: now() };
  await admin.from("TicketMessage").insert(msg);

  wsBroadcast("admin", "ticket:new", record);
  wsBroadcast(`ticket:${record.id}`, "ticket:new", record);

  res.status(201).json({ request: { ...record, timeline: [msg] } });
}));

app.post("/api/mobile/maintenance-requests/:id/messages", requireTenant, asyncWrap(async (req, res) => {
  const { message } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: "message required" });

  const { ["data"]: ticket } = await admin.from("MaintenanceRequest").select("id, tenantId").eq("id", req.params.id).single();
  if (!ticket || ticket.tenantId !== req.tenant.id) return res.status(404).json({ error: "Ticket not found" });

  const entry = {
    id: uid("TL"),
    requestId: req.params.id,
    author: req.tenant.name,
    author_kind: "tenant",
    tenantId: req.tenant.id,
    message: message.trim(),
    at: now(),
  };
  await admin.from("TicketMessage").insert(entry);

  wsBroadcast(`ticket:${req.params.id}`, "ticket:message", entry);
  wsBroadcast("admin", "ticket:message", entry);

  const { ["data"]: full } = await admin.from("MaintenanceRequest").select("*, TicketMessage(*)").eq("id", req.params.id).single();
  res.json({ request: withTimeline(full) });
}));

app.post("/api/mobile/maintenance-requests/:id/rating", requireTenant, asyncWrap(async (req, res) => {
  const { rating, comment } = req.body || {};
  const stars = Number(rating);
  if (!stars || stars < 1 || stars > 5) return res.status(400).json({ error: "rating must be 1-5" });

  const { ["data"]: ticket } = await admin.from("MaintenanceRequest").select("*").eq("id", req.params.id).single();
  if (!ticket || ticket.tenantId !== req.tenant.id) return res.status(404).json({ error: "Ticket not found" });

  await admin.from("MaintenanceRequest").update({ rating: stars, status: "Closed", updated_at: now() }).eq("id", req.params.id);

  const review = {
    id: uid("REV"), tenantId: req.tenant.id, buildingId: req.tenant.buildingId,
    requestId: req.params.id, rating: stars, comment: comment || "", createdAt: now(),
  };
  const { ["data"]: inserted, error } = await admin.from("Review").insert(review).select("*").single();
  if (error) return res.status(500).json({ error: error.message });

  wsBroadcast("admin", "ticket:rated", { requestId: req.params.id, rating: stars });
  wsBroadcast(`ticket:${req.params.id}`, "ticket:rated", { requestId: req.params.id, rating: stars });

  res.json({ review: inserted });
}));

app.post("/api/mobile/documents", requireTenant, asyncWrap(async (req, res) => {
  const { type, fileName, note, fileUrl } = req.body || {};
  if (!type || !fileName) return res.status(400).json({ error: "type and fileName required" });
  const doc = {
    id: uid("DOC"),
    tenantId: req.tenant.id,
    type, fileName, fileUrl: fileUrl || null,
    status: "Pending", note: note || "", submittedAt: now(),
  };
  const { data, error } = await admin.from("Document").insert(doc).select("*").single();
  if (error) return res.status(500).json({ error: error.message });
  wsBroadcast("admin", "document:new", data);
  res.status(201).json({ document: data });
}));

app.post("/api/mobile/quality-reports", requireTenant, asyncWrap(async (req, res) => {
  const { category, title, description, attachments } = req.body || {};
  if (!category || !description) return res.status(400).json({ error: "category and description required" });
  const report = {
    id: uid("QR"),
    tenantId: req.tenant.id,
    buildingId: req.tenant.buildingId,
    category, title: title || `${category} issue`, description,
    status: "Pending", attachments: Number(attachments) || 0, submittedAt: now(),
  };
  const { data, error } = await admin.from("QualityReport").insert(report).select("*").single();
  if (error) return res.status(500).json({ error: error.message });
  wsBroadcast("admin", "quality:new", data);
  res.status(201).json({ report: data });
}));

app.post("/api/mobile/broadcasts/:id/dismiss", requireTenant, asyncWrap(async (req, res) => {
  const { ["data"]: existing } = await admin.from("Broadcast").select("dismissedBy, buildingId").eq("id", req.params.id).single();
  if (!existing || existing.buildingId !== req.tenant.buildingId) return res.status(404).json({ error: "Not found" });
  const dismissedBy = Array.isArray(existing.dismissedBy) ? existing.dismissedBy : [];
  if (!dismissedBy.includes(req.tenant.id)) {
    await admin.from("Broadcast").update({ dismissedBy: [...dismissedBy, req.tenant.id] }).eq("id", req.params.id);
  }
  res.json({ ok: true });
}));

// ---------- DASHBOARD API (admin) ----------

app.get("/api/dashboard/stats", requireAdmin, asyncWrap(async (_req, res) => {
  const now_d = new Date();
  const monthStart = new Date(Date.UTC(now_d.getUTCFullYear(), now_d.getUTCMonth(), 1)).toISOString();

  const [
    buildingsRes, tenantsRes,
    openTicketsRes, resolvedMonthRes,
    techniciansRes, activeTecsRes,
    reviewsRes, recentTicketsRes, recentBroadcastsRes,
  ] = await Promise.all([
    admin.from("Building").select("*", { count: "exact", head: true }),
    admin.from("Tenant").select("*", { count: "exact", head: true }),
    admin.from("MaintenanceRequest").select("*", { count: "exact", head: true })
      .not("status", "in", '("Completed","Closed")'),
    admin.from("MaintenanceRequest").select("*", { count: "exact", head: true })
      .in("status", ["Completed", "Closed"])
      .gte("updated_at", monthStart),
    admin.from("Technician").select("*", { count: "exact", head: true }),
    admin.from("Technician").select("*", { count: "exact", head: true })
      .not("status", "eq", "Off"),
    admin.from("Review").select("rating"),
    admin.from("MaintenanceRequest")
      .select("id, title, status, buildingId, updated_at")
      .order("updated_at", { ascending: false })
      .limit(10),
    admin.from("Broadcast")
      .select("id, buildingId, title, createdAt")
      .order("createdAt", { ascending: false })
      .limit(10),
  ]);

  const reviews = reviewsRes.data || [];
  const qualityScore = reviews.length
    ? Math.round((reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / reviews.length) * 10) / 10
    : null;

  res.json({
    buildings:          buildingsRes.count        || 0,
    tenants:            tenantsRes.count           || 0,
    openTickets:        openTicketsRes.count       || 0,
    resolvedThisMonth:  resolvedMonthRes.count     || 0,
    technicians:        techniciansRes.count       || 0,
    activeTechnicians:  activeTecsRes.count        || 0,
    qualityScore,
    reviewsCount:       reviews.length,
    recentTickets:      (recentTicketsRes.data || []).map((t) => ({
      id: t.id, title: t.title, status: t.status,
      buildingName: t.buildingId, updatedAt: t.updated_at,
    })),
    recentBroadcasts:   (recentBroadcastsRes.data || []).map((b) => ({
      id: b.id, buildingName: b.buildingId, title: b.title, createdAt: b.createdAt,
    })),
  });
}));

app.get("/api/dashboard/tickets", requireAdmin, asyncWrap(async (req, res) => {
  const { status, buildingId, tenantId } = req.query;
  let q = admin.from("MaintenanceRequest").select("*, TicketMessage(*)").order("submittedAt", { ascending: false });
  if (status)     q = q.eq("status", status);
  if (buildingId) q = q.eq("buildingId", buildingId);
  if (tenantId)   q = q.eq("tenantId", tenantId);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  const tickets = (data || []).map(withTimeline);
  res.json({ tickets, total: tickets.length });
}));

app.get("/api/dashboard/tickets/:id", requireAdmin, asyncWrap(async (req, res) => {
  const { data, error } = await admin.from("MaintenanceRequest").select("*, TicketMessage(*)").eq("id", req.params.id).single();
  if (error || !data) return res.status(404).json({ error: "Ticket not found" });
  res.json({ request: withTimeline(data) });
}));

app.patch("/api/dashboard/tickets/:id", requireAdmin, asyncWrap(async (req, res) => {
  const { ["data"]: existing } = await admin.from("MaintenanceRequest").select("*").eq("id", req.params.id).single();
  if (!existing) return res.status(404).json({ error: "Ticket not found" });

  const { status, technicianId, technicianName, slaHours } = req.body || {};
  const updates = { updated_at: now() };
  if (status)          updates.status = status;
  if (technicianId !== undefined) updates.technicianId = technicianId || null;
  if (technicianName !== undefined) updates.technicianName = technicianName || null;
  if (slaHours != null) updates.slaHours = Number(slaHours) || 48;

  await admin.from("MaintenanceRequest").update(updates).eq("id", req.params.id);

  const parts = [];
  if (status && status !== existing.status) parts.push(`Status changed to ${status}`);
  if (technicianName && technicianName !== existing.technicianName) parts.push(`Assigned to ${technicianName}`);
  if (parts.length) {
    await admin.from("TicketMessage").insert({
      id: uid("TL"), requestId: req.params.id,
      author: req.admin.name, author_kind: "admin", adminId: req.admin.id,
      message: parts.join(". ") + ".", at: now(),
    });
  }

  const { ["data"]: full } = await admin.from("MaintenanceRequest").select("*, TicketMessage(*)").eq("id", req.params.id).single();
  const mapped = withTimeline(full);

  wsBroadcast(`ticket:${req.params.id}`, "ticket:updated", mapped);
  const { ["data"]: tenantRow } = await admin.from("Tenant").select("push_token").eq("id", existing.tenantId).single();
  if (tenantRow?.push_token && parts.length) {
    await sendExpoPush([tenantRow.push_token], "Ticket update", parts.join(". "), { type: "ticket", id: req.params.id });
  }

  res.json({ request: mapped });
}));

app.post("/api/dashboard/tickets/:id/messages", requireAdmin, asyncWrap(async (req, res) => {
  const { message } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: "message required" });

  const { ["data"]: ticket } = await admin.from("MaintenanceRequest").select("id, tenantId").eq("id", req.params.id).single();
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const entry = {
    id: uid("TL"), requestId: req.params.id,
    author: req.admin.name, author_kind: "admin", adminId: req.admin.id,
    message: message.trim(), at: now(),
  };
  await admin.from("TicketMessage").insert(entry);

  wsBroadcast(`ticket:${req.params.id}`, "ticket:message", entry);

  const { ["data"]: tenantRow } = await admin.from("Tenant").select("push_token").eq("id", ticket.tenantId).single();
  if (tenantRow?.push_token) {
    await sendExpoPush([tenantRow.push_token], "New message from building", message.trim().slice(0, 100), { type: "chat", id: req.params.id });
  }

  const { ["data"]: full } = await admin.from("MaintenanceRequest").select("*, TicketMessage(*)").eq("id", req.params.id).single();
  res.json({ request: withTimeline(full) });
}));

// ----- Buildings -----

app.get("/api/dashboard/buildings", requireAdmin, asyncWrap(async (_req, res) => {
  const { data, error } = await admin.from("Building").select("*").order("name");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ buildings: data || [] });
}));

app.post("/api/dashboard/buildings", requireAdmin, asyncWrap(async (req, res) => {
  const { name, code, address, units, floors, notes, image_url } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: "name and code required" });
  const building = {
    id: `BLD-${String(code).toUpperCase().slice(0,8)}-${Math.random().toString(36).slice(2,6).toUpperCase()}`,
    code: String(code).toUpperCase(), name,
    address: address || "", units: Number(units) || 0, floors: Number(floors) || 0,
    notes: notes || "", image_url: image_url || null,
  };
  const { data, error } = await admin.from("Building").insert(building).select("*").single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ building: data });
}));

app.patch("/api/dashboard/buildings/:id", requireAdmin, asyncWrap(async (req, res) => {
  const allowed = ["name", "code", "address", "units", "floors", "notes", "image_url"];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  if (updates.code) updates.code = String(updates.code).toUpperCase();
  const { data, error } = await admin.from("Building").update(updates).eq("id", req.params.id).select("*").single();
  if (error || !data) return res.status(404).json({ error: "Building not found" });
  res.json({ building: data });
}));

app.delete("/api/dashboard/buildings/:id", requireAdmin, asyncWrap(async (req, res) => {
  const { count } = await admin.from("Tenant").select("*", { count: "exact", head: true }).eq("buildingId", req.params.id);
  if ((count || 0) > 0) return res.status(409).json({ error: "Building has tenants; move them first" });
  const { error } = await admin.from("Building").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
}));

// ----- Tenants -----

app.get("/api/dashboard/tenants", requireAdmin, asyncWrap(async (_req, res) => {
  const { data, error } = await admin.from("Tenant").select("*").order("name");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tenants: data || [] });
}));

app.get("/api/dashboard/tenants/:tenantId", requireAdmin, asyncWrap(async (req, res) => {
  const [{ ["data"]: tenant }, { ["data"]: documents }, { ["data"]: tickets }] = await Promise.all([
    admin.from("Tenant").select("*, Building:buildingId(*)").eq("id", req.params.tenantId).single(),
    admin.from("Document").select("*").eq("tenantId", req.params.tenantId).order("submittedAt", { ascending: false }),
    admin.from("MaintenanceRequest").select("*").eq("tenantId", req.params.tenantId).order("submittedAt", { ascending: false }),
  ]);
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });
  res.json({ tenant, documents: documents || [], tickets: tickets || [] });
}));

app.patch("/api/dashboard/tenants/:tenantId", requireAdmin, asyncWrap(async (req, res) => {
  const allowed = ["name", "phone", "unit", "buildingId", "is_verified"];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  const { data, error } = await admin.from("Tenant").update(updates).eq("id", req.params.tenantId).select("*").single();
  if (error || !data) return res.status(404).json({ error: "Tenant not found" });
  res.json({ tenant: data });
}));

// ----- Technicians -----

app.get("/api/dashboard/technicians", requireAdmin, asyncWrap(async (_req, res) => {
  const { data, error } = await admin.from("Technician").select("*").order("name");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ technicians: data || [] });
}));

app.post("/api/dashboard/technicians", requireAdmin, asyncWrap(async (req, res) => {
  const { name, trade, phone, zone, status, rating } = req.body || {};
  if (!name || !trade) return res.status(400).json({ error: "name and trade required" });
  const tech = {
    id: `TEC-${Date.now().toString(36).toUpperCase()}`,
    name, trade, phone: phone || "", zone: zone || "",
    status: status || "Available", rating: Number(rating) || 0,
  };
  const { data, error } = await admin.from("Technician").insert(tech).select("*").single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ technician: data });
}));

app.patch("/api/dashboard/technicians/:id", requireAdmin, asyncWrap(async (req, res) => {
  const allowed = ["name", "trade", "phone", "zone", "status", "rating"];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  const { data, error } = await admin.from("Technician").update(updates).eq("id", req.params.id).select("*").single();
  if (error || !data) return res.status(404).json({ error: "Technician not found" });
  res.json({ technician: data });
}));

app.delete("/api/dashboard/technicians/:id", requireAdmin, asyncWrap(async (req, res) => {
  const { error } = await admin.from("Technician").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
}));

// ----- Quality reports / documents -----

app.get("/api/dashboard/quality-reports", requireAdmin, asyncWrap(async (_req, res) => {
  const { data } = await admin.from("QualityReport").select("*").order("submittedAt", { ascending: false });
  res.json({ reports: data || [] });
}));
app.patch("/api/dashboard/quality-reports/:id", requireAdmin, asyncWrap(async (req, res) => {
  const { status } = req.body || {};
  const { data, error } = await admin.from("QualityReport").update({ status }).eq("id", req.params.id).select("*").single();
  if (error || !data) return res.status(404).json({ error: "Report not found" });
  res.json({ report: data });
}));

app.get("/api/dashboard/documents", requireAdmin, asyncWrap(async (_req, res) => {
  const { data } = await admin.from("Document").select("*, Tenant:tenantId(name, unit, buildingId)").order("submittedAt", { ascending: false });
  res.json({ documents: data || [] });
}));
app.patch("/api/dashboard/documents/:id", requireAdmin, asyncWrap(async (req, res) => {
  const { status, note } = req.body || {};
  const updates = {};
  if (status !== undefined) updates.status = status;
  if (note !== undefined) updates.note = note;
  const { data, error } = await admin.from("Document").update(updates).eq("id", req.params.id).select("*").single();
  if (error || !data) return res.status(404).json({ error: "Document not found" });
  res.json({ document: data });
}));

// ----- Analytics -----

app.get("/api/dashboard/analytics/maintenance", requireAdmin, asyncWrap(async (req, res) => {
  const report = await buildMaintenanceReport({
    from: req.query.from,
    to: req.query.to,
    buildingId: req.query.buildingId,
  });
  res.json(report);
}));

// ----- Exports -----

function sendFile(res, buffer, filename, mime) {
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", buffer.length);
  res.end(buffer);
}

app.get("/api/dashboard/exports/tickets", requireAdmin, asyncWrap(async (req, res) => {
  const format = (req.query.format || "pdf").toString().toLowerCase();
  let q = admin.from("MaintenanceRequest").select("*").order("submittedAt", { ascending: false });
  if (req.query.status)     q = q.eq("status", req.query.status);
  if (req.query.buildingId) q = q.eq("buildingId", req.query.buildingId);
  const { ["data"]: tickets } = await q;
  if (format === "xlsx" || format === "excel") {
    const { buffer, filename } = await ticketsToExcel(tickets || []);
    return sendFile(res, Buffer.from(buffer), filename, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }
  const { buffer, filename } = await ticketsToPdf(tickets || []);
  return sendFile(res, buffer, filename, "application/pdf");
}));

app.get("/api/dashboard/exports/maintenance-report", requireAdmin, asyncWrap(async (req, res) => {
  const format = (req.query.format || "pdf").toString().toLowerCase();
  const report = await buildMaintenanceReport({
    from: req.query.from, to: req.query.to, buildingId: req.query.buildingId,
  });
  if (format === "xlsx" || format === "excel") {
    const { buffer, filename } = await maintenanceReportToExcel(report);
    return sendFile(res, Buffer.from(buffer), filename, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }
  const { buffer, filename } = await maintenanceReportToPdf(report);
  return sendFile(res, buffer, filename, "application/pdf");
}));

app.get("/api/dashboard/exports/tenants/:tenantId/profile", requireAdmin, asyncWrap(async (req, res) => {
  const format = (req.query.format || "pdf").toString().toLowerCase();
  const [{ ["data"]: tenant }, { ["data"]: docs }, { ["data"]: tickets }] = await Promise.all([
    admin.from("Tenant").select("*, Building:buildingId(*)").eq("id", req.params.tenantId).single(),
    admin.from("Document").select("*").eq("tenantId", req.params.tenantId).order("submittedAt", { ascending: false }),
    admin.from("MaintenanceRequest").select("*").eq("tenantId", req.params.tenantId).order("submittedAt", { ascending: false }),
  ]);
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  if (format === "xlsx" || format === "excel") {
    const { buffer, filename } = await tenantProfileToExcel(tenant, docs || [], tickets || []);
    return sendFile(res, Buffer.from(buffer), filename, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }
  const { buffer, filename } = await tenantProfileToPdf(tenant, docs || [], tickets || []);
  return sendFile(res, buffer, filename, "application/pdf");
}));

// ----- Broadcasts -----

app.post("/api/dashboard/buildings/:id/broadcast", requireAdmin, asyncWrap(async (req, res) => {
  const { title, message, displayUntil } = req.body || {};
  if (!message?.trim() || !displayUntil) return res.status(400).json({ error: "message and displayUntil required" });

  const broadcast = {
    id: uid("BCK"),
    buildingId: req.params.id,
    title: (title?.trim()) || "Building Announcement",
    message: message.trim(),
    sentBy: req.admin.name,
    createdAt: now(),
    displayUntil: new Date(displayUntil).toISOString(),
    dismissedBy: [],
  };
  const { error } = await admin.from("Broadcast").insert(broadcast);
  if (error) return res.status(500).json({ error: error.message });

  const { ["data"]: tenants } = await admin.from("Tenant").select("push_token").eq("buildingId", req.params.id).not("push_token", "is", null);
  const tokens = (tenants || []).map(t => t.push_token).filter(Boolean);
  const pushResult = await sendExpoPush(tokens, broadcast.title, broadcast.message, { type: "broadcast", buildingId: req.params.id });

  wsBroadcast(`building:${req.params.id}`, "broadcast:new", broadcast);

  res.status(201).json({ broadcast, pushed: pushResult.sent });
}));

app.get("/api/dashboard/buildings/:id/broadcasts", requireAdmin, asyncWrap(async (req, res) => {
  const { data } = await admin.from("Broadcast").select("*").eq("buildingId", req.params.id).order("createdAt", { ascending: false }).limit(40);
  res.json({ broadcasts: data || [] });
}));

// ---------- Units / Roster / Tenant-internal routes (Phase 3) ----------
registerUnitsRosterRoutes(app, { admin, requireAdmin, asyncWrap });

// ---------- 404 ----------
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ---------- start and graceful shutdown ----------
let backupTimer = null;
let accountDeletionTimer = null;

async function disableExpiredTenantAccess() {
  const result = await admin.from("Tenant").update({ access_disabled_at: now() })
    .not("deletion_scheduled_for", "is", null)
    .lte("deletion_scheduled_for", now())
    .is("access_disabled_at", null)
    .select("id, auth_user_id");
  if (result.error) throw result.error;
  const authErrors = [];
  for (const tenant of result.data || []) {
    if (!tenant.auth_user_id) continue;
    const banned = await admin.auth.admin.updateUserById(tenant.auth_user_id, { ban_duration: "876000h" });
    if (banned.error) authErrors.push(tenant.id);
  }
  if ((result.data || []).length) console.log(`[accounts] disabled access for ${result.data.length} expired deletion request(s)`);
  if (authErrors.length) throw new Error(`Supabase Auth ban failed for ${authErrors.length} expired account(s)`);
}

httpServer.on("error", (error) => {
  console.error(`[server] listen/runtime error: ${error.code || ""} ${error.message}`);
  process.exitCode = 1;
});

async function startRuntime() {
  await backupService.initialize();
  const runtime = await markRunning(RELEASE_ID).catch((error) => ({ markerError: error.message }));
  if (runtime.uncleanRestart) {
    await operations.sendAlert({
      incidentKey: `runtime:unclean-restart:${runtime.previous?.releaseId || "unknown"}`,
      event: "unclean-server-restart-detected",
      severity: "critical",
      component: "Railway server runtime",
      message: "The persistent runtime marker shows the previous process did not complete graceful shutdown.",
      healthStatus: "degraded",
      recommendedAction: "Inspect Railway deployment/runtime logs and the prior release, then verify readiness, background work, WebSockets, and backup integrity.",
    }).catch(() => {});
  }
  operations.startMonitoring();
  disableExpiredTenantAccess().catch((error) => console.error("[accounts] deletion processor failed:", error.message));
  accountDeletionTimer = setInterval(() => {
    disableExpiredTenantAccess().catch((error) => operations.sendAlert({ incidentKey: "accounts:deletion-processor", event: "account-deletion-processor-failed", severity: "critical", component: "Account access deletion processor", error: error.message, recommendedAction: "Check the Tenant migration and Supabase database, then rerun the processor." }).catch(() => {}));
  }, Number(process.env.ACCOUNT_DELETION_INTERVAL_MS || 60 * 60 * 1000));
  accountDeletionTimer.unref?.();
  if (backupService.enabled) {
    const intervalMs = Number(process.env.BACKUP_INTERVAL_MS || 24 * 60 * 60 * 1000);
    backupTimer = setInterval(() => {
      backupService.run("scheduled").catch((error) => {
        console.error("[backup] scheduled backup failed:", error.message);
        operations.sendAlert({ incidentKey: "backup:last-failure", event: "backup-failed", severity: "critical", component: "Backup and cloud mirror", error: error.message, recommendedAction: "Restore local and Supabase Storage backup destinations, rerun the backup, then verify it." }).catch(() => {});
      });
    }, intervalMs);
    backupTimer.unref?.();
  }
  console.log(`PropertyPortal Server — http://localhost:${PORT}`);
  console.log(`  Environment → ${ENVIRONMENT}`);
  console.log(`  Release     → ${RELEASE_ID}`);
  console.log("  Auth       → /api/auth/{admin|tenant}/*");
  console.log("  Mobile     → /api/mobile/*");
  console.log("  Dashboard  → /api/dashboard/*");
  console.log("  Realtime   → ws://host:PORT/ws");
}

httpServer.listen(PORT, () => {
  startRuntime().catch(async (error) => {
    console.error("[startup] initialization failed:", error.message);
    await operations.sendAlert({
      incidentKey: `startup:${RELEASE_ID}`,
      event: "deployment-startup-health-failed",
      severity: "critical",
      component: "Railway deployment startup",
      message: error.message,
      healthStatus: "unhealthy",
      recommendedAction: "Inspect Railway startup logs, environment variables, persistent volume and Supabase migration state; roll back if readiness cannot be restored.",
    }).catch(() => {});
    process.exitCode = 1;
    httpServer.close();
  });
});

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received; draining ${inFlightRequests} active request(s)`);
  operations.stopMonitoring();
  if (backupTimer) clearInterval(backupTimer);
  if (accountDeletionTimer) clearInterval(accountDeletionTimer);

  for (const client of wsClients) {
    try { client.socket.close(1001, "Server restarting"); } catch {}
  }
  wss.close();

  const closeServer = new Promise((resolve) => httpServer.close(resolve));
  const drainTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS || 15000);
  let drainTimer;
  await Promise.race([
    closeServer,
    new Promise((resolve) => { drainTimer = setTimeout(resolve, drainTimeoutMs); }),
  ]);
  clearTimeout(drainTimer);
  httpServer.closeIdleConnections?.();
  if (inFlightRequests > 0) httpServer.closeAllConnections?.();

  if (backupService.enabled && process.env.BACKUP_ON_SHUTDOWN === "true") {
    const backupTimeoutMs = Number(process.env.SHUTDOWN_BACKUP_TIMEOUT_MS || 30000);
    let backupTimeout;
    await Promise.race([
      backupService.run(`shutdown:${signal}`).catch((error) => console.error("[shutdown] backup failed:", error.message)),
      new Promise((resolve) => { backupTimeout = setTimeout(resolve, backupTimeoutMs); }),
    ]);
    clearTimeout(backupTimeout);
  }

  const incomplete = inFlightRequests > 0;
  console.log(`[shutdown] complete; ${inFlightRequests} request(s) remained at close`);
  if (incomplete) {
    await operations.sendAlert({ incidentKey: `shutdown:${RELEASE_ID}`, event: "shutdown-drain-failed", severity: "critical", component: "Railway server shutdown", message: `${inFlightRequests} request(s) remained after the shutdown window`, healthStatus: "shutting_down", recommendedAction: "Check Railway termination timing and request duration; confirm the next release is ready before restoring traffic." }).catch(() => {});
  }
  await markStopped(RELEASE_ID, signal).catch((error) => console.error("[shutdown] runtime marker failed:", error.message));
  process.exitCode = incomplete ? 1 : 0;
}

process.once("SIGTERM", () => { gracefulShutdown("SIGTERM").catch((error) => { console.error(error); process.exitCode = 1; }); });
process.once("SIGINT", () => { gracefulShutdown("SIGINT").catch((error) => { console.error(error); process.exitCode = 1; }); });
