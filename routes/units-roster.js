"use strict";

// PropertyPortal units + tenant roster + tenant-internal-notes routes.
// Mount via: require("./routes/units-roster")(app, { admin, requireAdmin, asyncWrap });

const crypto = require("crypto");

// --- small helpers ---

const now = () => new Date().toISOString();

function normalizeName(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function nameMatches(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Tolerate up to 2 edits on short names, more on long ones
  const maxDist = Math.min(3, Math.max(1, Math.floor(Math.min(na.length, nb.length) / 5)));
  return levenshtein(na, nb) <= maxDist;
}

function parseCsv(text) {
  // Simple CSV parser: handles quoted fields, commas in quotes, CRLF/LF.
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch === "\r") { /* skip */ }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c || "").trim().length > 0));
}

function unitId(buildingCode, unitNumber) {
  const b = String(buildingCode || "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
  const u = String(unitNumber || "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return `UNT-${b}-${u}`;
}

function rosterIdNew() {
  return `ROS-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

// --- main export ---

module.exports = function registerUnitsRosterRoutes(app, deps) {
  const { admin, requireAdmin, asyncWrap } = deps;

  // =========== UNITS ===========

  // List units for a building
  app.get("/api/dashboard/buildings/:buildingId/units", requireAdmin, asyncWrap(async (req, res) => {
    const { data, error } = await admin.from("Unit")
      .select("*")
      .eq("buildingId", req.params.buildingId)
      .order("unit_number");
    if (error) return res.status(500).json({ error: error.message });
    res.json({ units: data || [] });
  }));

  // Get one unit with full history (current tenant, tenant history, maintenance history)
  app.get("/api/dashboard/units/:id", requireAdmin, asyncWrap(async (req, res) => {
    const { ["data"]: unit, error } = await admin.from("Unit").select("*, Building:buildingId(id,name,code)").eq("id", req.params.id).single();
    if (error || !unit) return res.status(404).json({ error: "Unit not found" });

    const [tenantsRes, requestsRes] = await Promise.all([
      admin.from("Tenant")
        .select("id, name, email, phone, is_verified, is_current, move_in_at, move_out_at, created_at")
        .eq("unitId", unit.id)
        .order("move_in_at", { ascending: false, nullsFirst: false }),
      admin.from("MaintenanceRequest")
        .select("id, title, category, status, submittedAt, updated_at, rating, technicianName, tenantName")
        .eq("unitId", unit.id)
        .order("submittedAt", { ascending: false })
        .limit(200),
    ]);

    const tenants = tenantsRes.data || [];
    const currentTenant = tenants.find(t => t.is_current) || null;
    const tenantHistory = tenants.filter(t => t !== currentTenant);

    res.json({
      unit,
      currentTenant,
      tenantHistory,
      maintenanceHistory: requestsRes.data || [],
    });
  }));

  // Create a unit for a building
  app.post("/api/dashboard/buildings/:buildingId/units", requireAdmin, asyncWrap(async (req, res) => {
    const { unit_number, unit_type, bedrooms, bathrooms, sqft, floor, notes } = req.body || {};
    if (!unit_number) return res.status(400).json({ error: "unit_number required" });

    const { ["data"]: building } = await admin.from("Building").select("id, code").eq("id", req.params.buildingId).single();
    if (!building) return res.status(404).json({ error: "Building not found" });

    const row = {
      id: unitId(building.code || building.id, unit_number),
      buildingId: building.id,
      unit_number: String(unit_number).toUpperCase(),
      unit_type: unit_type || "Studio",
      bedrooms: Number(bedrooms) || 0,
      bathrooms: Number(bathrooms) || 0,
      sqft: sqft ? Number(sqft) : null,
      floor: floor !== undefined && floor !== null && floor !== "" ? Number(floor) : null,
      notes: notes || "",
    };
    const { data, error } = await admin.from("Unit").insert(row).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ unit: data });
  }));

  // Update a unit
  app.patch("/api/dashboard/units/:id", requireAdmin, asyncWrap(async (req, res) => {
    const allowed = ["unit_number", "unit_type", "bedrooms", "bathrooms", "sqft", "floor", "notes"];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    if (updates.unit_number) updates.unit_number = String(updates.unit_number).toUpperCase();
    const { data, error } = await admin.from("Unit").update(updates).eq("id", req.params.id).select("*").single();
    if (error || !data) return res.status(404).json({ error: "Unit not found" });
    res.json({ unit: data });
  }));

  // Delete a unit (fails if tenants are linked)
  app.delete("/api/dashboard/units/:id", requireAdmin, asyncWrap(async (req, res) => {
    const { count } = await admin.from("Tenant").select("*", { count: "exact", head: true }).eq("unitId", req.params.id);
    if ((count || 0) > 0) return res.status(409).json({ error: "Unit has tenants linked; reassign or move them out first" });
    const { error } = await admin.from("Unit").delete().eq("id", req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.status(204).end();
  }));

  // =========== TENANT ROSTER ===========

  // List roster entries, filterable
  app.get("/api/dashboard/roster", requireAdmin, asyncWrap(async (req, res) => {
    const { status, buildingId } = req.query;
    let q = admin.from("TenantRoster").select("*, Building:buildingId(id,name,code)").order("uploaded_at", { ascending: false });
    if (status) q = q.eq("status", status);
    if (buildingId) q = q.eq("buildingId", buildingId);
    const { data, error } = await q.limit(1000);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ roster: data || [] });
  }));

  // Add one roster entry manually
  app.post("/api/dashboard/roster", requireAdmin, asyncWrap(async (req, res) => {
    const { buildingId, unit_number, unit_type, full_name, email, phone } = req.body || {};
    if (!buildingId || !unit_number || !full_name) {
      return res.status(400).json({ error: "buildingId, unit_number, full_name required" });
    }
    const { ["data"]: building } = await admin.from("Building").select("id, code").eq("id", buildingId).single();
    if (!building) return res.status(404).json({ error: "Building not found" });

    // Find or create matching unit
    const uNum = String(unit_number).toUpperCase();
    let { ["data"]: u } = await admin.from("Unit").select("id").eq("buildingId", buildingId).eq("unit_number", uNum).maybeSingle();
    if (!u) {
      const uid = unitId(building.code || building.id, uNum);
      const ins = await admin.from("Unit").insert({
        id: uid, buildingId, unit_number: uNum, unit_type: unit_type || "Studio",
      }).select("id").single();
      u = ins.data || { id: uid };
    }

    const row = {
      id: rosterIdNew(),
      buildingId,
      unitId: u.id,
      unit_number: uNum,
      unit_type: unit_type || null,
      full_name: String(full_name).trim(),
      email: email ? String(email).toLowerCase().trim() : null,
      phone: phone || null,
      status: "pending",
      uploaded_by: req.admin?.email || "admin",
    };
    const { data, error } = await admin.from("TenantRoster").insert(row).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ entry: data });
  }));

  // Upload CSV roster: body is { csv: "..." } OR text/csv body
  app.post("/api/dashboard/roster/upload", requireAdmin, asyncWrap(async (req, res) => {
    let csvText = "";
    if (req.is("text/csv")) csvText = typeof req.body === "string" ? req.body : String(req.body || "");
    else csvText = String(req.body?.csv || "");
    if (!csvText.trim()) return res.status(400).json({ error: "CSV body is empty. Send text/csv or JSON {csv: '...'}" });

    const rows = parseCsv(csvText);
    if (rows.length < 2) return res.status(400).json({ error: "CSV must have a header row and at least one data row" });

    // Locate columns by header name (case-insensitive)
    const header = rows[0].map(h => String(h || "").trim().toLowerCase());
    const idx = (...names) => names.reduce((acc, n) => acc !== -1 ? acc : header.indexOf(n), -1);
    const iCode = idx("building_code", "buildingcode", "building code");
    const iUnitNum = idx("unit_number", "unitnumber", "unit", "unit number");
    const iUnitType = idx("unit_type", "unittype", "type", "unit type");
    const iName = idx("tenant_name", "name", "full_name", "fullname", "tenant name");
    const iEmail = idx("email", "e-mail");
    const iPhone = idx("phone", "mobile", "tel");

    if (iCode === -1 || iUnitNum === -1 || iName === -1) {
      return res.status(400).json({ error: "CSV must include headers: building_code, unit_number, tenant_name (email, phone, unit_type optional)" });
    }

    // Preload buildings by code
    const { ["data"]: buildingsData } = await admin.from("Building").select("id, code");
    const buildingByCode = new Map((buildingsData || []).map(b => [String(b.code || "").toUpperCase(), b]));

    const created = [];
    const skipped = [];
    const uploadedBy = req.admin?.email || "admin";

    for (let r = 1; r < rows.length; r++) {
      const cols = rows[r];
      const codeRaw = String(cols[iCode] || "").toUpperCase().trim();
      const unitNumRaw = String(cols[iUnitNum] || "").toUpperCase().trim();
      const nameRaw = String(cols[iName] || "").trim();
      const typeRaw = iUnitType >= 0 ? String(cols[iUnitType] || "").trim() : "";
      const emailRaw = iEmail >= 0 ? String(cols[iEmail] || "").toLowerCase().trim() : "";
      const phoneRaw = iPhone >= 0 ? String(cols[iPhone] || "").trim() : "";

      if (!codeRaw || !unitNumRaw || !nameRaw) {
        skipped.push({ row: r + 1, reason: "missing required field" });
        continue;
      }
      const b = buildingByCode.get(codeRaw);
      if (!b) {
        skipped.push({ row: r + 1, reason: `unknown building code '${codeRaw}'` });
        continue;
      }

      // Find or create unit
      let { ["data"]: u } = await admin.from("Unit").select("id").eq("buildingId", b.id).eq("unit_number", unitNumRaw).maybeSingle();
      if (!u) {
        const uid = unitId(codeRaw, unitNumRaw);
        const ins = await admin.from("Unit").insert({
          id: uid, buildingId: b.id, unit_number: unitNumRaw, unit_type: typeRaw || "Studio",
        }).select("id").single();
        if (ins.error) { skipped.push({ row: r + 1, reason: ins.error.message }); continue; }
        u = ins.data;
      } else if (typeRaw) {
        // Optional: refresh unit_type if blank on existing row
        await admin.from("Unit").update({ unit_type: typeRaw }).eq("id", u.id).is("unit_type", null);
      }

      const rosterRow = {
        id: rosterIdNew(),
        buildingId: b.id,
        unitId: u.id,
        unit_number: unitNumRaw,
        unit_type: typeRaw || null,
        full_name: nameRaw,
        email: emailRaw || null,
        phone: phoneRaw || null,
        status: "pending",
        uploaded_by: uploadedBy,
      };
      const ins = await admin.from("TenantRoster").insert(rosterRow).select("id").single();
      if (ins.error) { skipped.push({ row: r + 1, reason: ins.error.message }); continue; }
      created.push(ins.data.id);
    }

    res.status(201).json({ created_count: created.length, skipped });
  }));

  // Archive a roster entry
  app.patch("/api/dashboard/roster/:id", requireAdmin, asyncWrap(async (req, res) => {
    const allowed = ["full_name", "email", "phone", "unit_type", "status"];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const { data, error } = await admin.from("TenantRoster").update(updates).eq("id", req.params.id).select("*").single();
    if (error || !data) return res.status(404).json({ error: "Roster entry not found" });
    res.json({ entry: data });
  }));

  app.delete("/api/dashboard/roster/:id", requireAdmin, asyncWrap(async (req, res) => {
    const { error } = await admin.from("TenantRoster").delete().eq("id", req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.status(204).end();
  }));

  // =========== TENANT INTERNAL NOTES ===========

  app.patch("/api/dashboard/tenants/:id/notes", requireAdmin, asyncWrap(async (req, res) => {
    const { internal_notes } = req.body || {};
    if (typeof internal_notes !== "string") return res.status(400).json({ error: "internal_notes string required" });
    const { data, error } = await admin.from("Tenant").update({ internal_notes }).eq("id", req.params.id).select("id, internal_notes").single();
    if (error || !data) return res.status(404).json({ error: "Tenant not found" });
    res.json({ tenant: data });
  }));

  // Tenant detail (admin view) with reviews aggregate + request history
  // Use /full suffix to avoid conflict with existing /api/dashboard/tenants/:tenantId
  app.get("/api/dashboard/tenants/:id/full", requireAdmin, asyncWrap(async (req, res) => {
    const { ["data"]: tenant, error } = await admin.from("Tenant")
      .select("*, Building:buildingId(id,name,code), Unit:unitId(id,unit_number,unit_type)")
      .eq("id", req.params.id).single();
    if (error || !tenant) return res.status(404).json({ error: "Tenant not found" });

    const [requestsRes, reviewsRes] = await Promise.all([
      admin.from("MaintenanceRequest")
        .select("id, title, category, status, submittedAt, updated_at, rating, technicianName, unit")
        .eq("tenantId", tenant.id)
        .order("submittedAt", { ascending: false }).limit(200),
      admin.from("Review").select("rating").eq("tenantId", tenant.id),
    ]);

    const requests = requestsRes.data || [];
    const reviews = reviewsRes.data || [];
    const avg = reviews.length ? reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length : null;

    res.json({
      tenant,
      stats: {
        totalRequests: requests.length,
        openRequests: requests.filter(r => r.status && r.status !== "Closed").length,
        avgRating: avg,
        reviewsCount: reviews.length,
      },
      requests,
    });
  }));

  // =========== BUILDING PHOTO UPLOAD ===========

  // POST /api/dashboard/buildings/:id/photo  body { image_base64: "...", mime: "image/jpeg" }
  app.post("/api/dashboard/buildings/:id/photo", requireAdmin, asyncWrap(async (req, res) => {
    const { image_base64, mime } = req.body || {};
    if (!image_base64) return res.status(400).json({ error: "image_base64 required" });
    const mt = (mime || "image/jpeg").toLowerCase();
    const ext = mt === "image/png" ? "png" : mt === "image/webp" ? "webp" : mt === "image/gif" ? "gif" : "jpg";
    const buf = Buffer.from(image_base64.replace(new RegExp("^" + "data" + ":[^,]+,"), ""), "base64");
    if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: "Image exceeds 10 MB" });

    const path = `${req.params.id}/${Date.now()}.${ext}`;
    const up = await admin.storage.from("building-photos").upload(path, buf, { contentType: mt, upsert: true });
    if (up.error) return res.status(500).json({ error: up.error.message });

    const { ["data"]: pub } = admin.storage.from("building-photos").getPublicUrl(path);
    const image_url = pub?.publicUrl || null;

    const { data, error } = await admin.from("Building").update({ image_url }).eq("id", req.params.id).select("*").single();
    if (error || !data) return res.status(404).json({ error: "Building not found" });
    res.json({ building: data });
  }));

  // =========== TENANT SIGNUP (roster-gated) ===========
  // This is POSTED by the mobile app; returns 401 if no roster match.

  app.post("/api/auth/tenant/signup-rostered", asyncWrap(async (req, res) => {
    const { name, email, password, phone, building_code, unit_number } = req.body || {};
    if (!name || !email || !password || !building_code || !unit_number) {
      return res.status(400).json({ error: "name, email, password, building_code, unit_number required" });
    }
    if (String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const codeU = String(building_code).toUpperCase().trim();
    const unitU = String(unit_number).toUpperCase().trim();

    const { ["data"]: building } = await admin.from("Building").select("id, code").eq("code", codeU).maybeSingle();
    if (!building) return res.status(404).json({ error: "Building not found. Check the building code." });

    // Pull all pending roster entries for this building+unit (could be multiple historical)
    const { ["data"]: candidates } = await admin.from("TenantRoster")
      .select("*")
      .eq("buildingId", building.id)
      .eq("unit_number", unitU)
      .eq("status", "pending");
    if (!candidates || candidates.length === 0) {
      return res.status(404).json({ error: "No roster entry for that building and unit. Please contact your operator." });
    }
    const match = candidates.find(c => nameMatches(c.full_name, name));
    if (!match) {
      return res.status(401).json({ error: "Your name doesn't match the registered tenant for this unit." });
    }

    // Prevent duplicate email
    const { ["data"]: existing } = await admin.from("Tenant").select("id").eq("email", String(email).toLowerCase()).maybeSingle();
    if (existing) return res.status(409).json({ error: "A tenant with this email already exists" });

    // Create Supabase auth user
    const { ["data"]: userRes, error: userErr } = await admin.auth.admin.createUser({
      email: String(email).toLowerCase(),
      password,
      email_confirm: true,
      ["user_metadata"]: { name, role: "tenant" },
    });
    if (userErr || !userRes?.user) return res.status(400).json({ error: userErr?.message || "Auth creation failed" });

    const tenantId = `TEN-${Date.now().toString(36).toUpperCase()}`;
    const insertRes = await admin.from("Tenant").insert({
      id: tenantId,
      auth_user_id: userRes.user.id,
      name,
      email: String(email).toLowerCase(),
      phone: phone || match.phone || "",
      unit: unitU,
      buildingId: building.id,
      unitId: match.unitId,
      is_verified: true,
      is_current: true,
      move_in_at: now(),
    }).select("*").single();

    if (insertRes.error) {
      await admin.auth.admin.deleteUser(userRes.user.id).catch(() => {});
      return res.status(500).json({ error: insertRes.error.message });
    }

    // Mark roster entry claimed
    await admin.from("TenantRoster").update({
      status: "claimed",
      claimed_tenant_id: tenantId,
      claimed_at: now(),
    }).eq("id", match.id);

    res.status(201).json({ tenant: insertRes.data, message: "Signup successful. Please sign in." });
  }));
};
