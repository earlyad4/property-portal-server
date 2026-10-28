"use strict";

const { admin } = require("./supabase");

function bucketize(list, keyFn) {
  const out = new Map();
  for (const item of list) {
    const k = keyFn(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  }
  return out;
}

function avg(arr) {
  if (!arr.length) return 0;
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100;
}

async function buildMaintenanceReport({ from, to, buildingId } = {}) {
  let q = admin.from("MaintenanceRequest").select("*").order("submittedAt", { ascending: false });
  if (from)       q = q.gte("submittedAt", from);
  if (to)         q = q.lte("submittedAt", to);
  if (buildingId) q = q.eq("buildingId", buildingId);

  const ticketsRes = await q;
  if (ticketsRes.error) throw new Error(ticketsRes.error.message);
  const tickets = ticketsRes.data || [];

  const buildingsRes = await admin.from("Building").select("id,name");
  const buildings = buildingsRes.data || [];

  const techsRes = await admin.from("Technician").select("id,name");
  const technicians = techsRes.data || [];

  const buildingName = function (id) {
    const b = buildings.find(function (x) { return x.id === id; });
    return b ? b.name : id;
  };

  const completed = tickets.filter(t => ["Completed", "Closed"].includes(t.status));
  const open      = tickets.filter(t => !["Completed", "Closed"].includes(t.status));
  const rated     = tickets.filter(t => typeof t.rating === "number");

  const summary = {
    "Total tickets":      tickets.length,
    "Open":               open.length,
    "Completed / closed": completed.length,
    "Pending":            tickets.filter(t => t.status === "Pending").length,
    "In progress":        tickets.filter(t => t.status === "In Progress").length,
    "Avg SLA (hours)":    avg(tickets.map(t => Number(t.slaHours) || 0)),
    "Average rating":     avg(rated.map(t => t.rating)),
    "Ratings received":   rated.length,
  };

  const byBuildingMap = bucketize(tickets, t => t.buildingId);
  const byBuilding = [...byBuildingMap.entries()].map(([id, arr]) => ({
    building:   buildingName(id),
    open:       arr.filter(t => !["Completed", "Closed"].includes(t.status)).length,
    completed:  arr.filter(t => ["Completed", "Closed"].includes(t.status)).length,
    avgSla:     avg(arr.map(t => Number(t.slaHours) || 0)),
    avgRating:  avg(arr.filter(t => typeof t.rating === "number").map(t => t.rating)),
  }));

  const byCategoryMap = bucketize(tickets, t => t.category);
  const byCategory = [...byCategoryMap.entries()].map(([category, arr]) => ({
    category,
    total:     arr.length,
    completed: arr.filter(t => ["Completed", "Closed"].includes(t.status)).length,
  }));

  const byTechMap = bucketize(tickets.filter(t => t.technicianName), t => t.technicianName);
  const byTechnician = [...byTechMap.entries()].map(([technician, arr]) => ({
    technician,
    open:      arr.filter(t => !["Completed", "Closed"].includes(t.status)).length,
    completed: arr.filter(t => ["Completed", "Closed"].includes(t.status)).length,
    avgRating: avg(arr.filter(t => typeof t.rating === "number").map(t => t.rating)),
  }));

  const daily = new Map();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    daily.set(d.toISOString().slice(0, 10), { date: d.toISOString().slice(0, 10), opened: 0, closed: 0 });
  }
  for (const t of tickets) {
    const key = String(t.submittedAt).slice(0, 10);
    if (daily.has(key)) daily.get(key).opened += 1;
    if (["Completed", "Closed"].includes(t.status) && t.updated_at) {
      const ck = String(t.updated_at).slice(0, 10);
      if (daily.has(ck)) daily.get(ck).closed += 1;
    }
  }

  return {
    summary,
    byBuilding,
    byCategory,
    byTechnician,
    dailyVolume: [...daily.values()],
    tickets,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildMaintenanceReport };
