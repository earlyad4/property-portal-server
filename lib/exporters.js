"use strict";

const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

// ------------------- shared -------------------

function sanitizeName(s) {
  return String(s || "").replace(/[^a-zA-Z0-9_\-]/g, "_").replace(/_+/g, "_");
}
function fmtDate(v) {
  return v ? new Date(v).toLocaleString("en-GB") : "—";
}

// ------------------- Excel -------------------

async function workbookFromSheets(sheets, filename) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "PropertyPortal";
  wb.created = new Date();

  for (const def of sheets) {
    const ws = wb.addWorksheet(def.name);
    ws.columns = def.columns;
    def.rows.forEach(r => ws.addRow(r));
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF8C1C13" } };
    ws.columns.forEach(col => {
      col.width = Math.max(
        col.header?.toString().length || 10,
        ...def.rows.map(r => String(r[col.key] ?? "").length),
        12,
      ) + 2;
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }

  return { buffer: await wb.xlsx.writeBuffer(), filename: `${filename}.xlsx` };
}

async function ticketsToExcel(tickets) {
  return workbookFromSheets([{
    name: "Tickets",
    columns: [
      { header: "Ticket ID",      key: "id",           width: 18 },
      { header: "Submitted",      key: "submittedAt",  width: 20 },
      { header: "Category",       key: "category",     width: 14 },
      { header: "Title",          key: "title",        width: 40 },
      { header: "Building",       key: "buildingId",   width: 16 },
      { header: "Unit",           key: "unit",         width: 10 },
      { header: "Tenant",         key: "tenantName",   width: 22 },
      { header: "Status",         key: "status",       width: 14 },
      { header: "Technician",     key: "technicianName", width: 20 },
      { header: "SLA (h)",        key: "slaHours",     width: 10 },
      { header: "Rating",         key: "rating",       width: 10 },
      { header: "Description",    key: "description",  width: 50 },
    ],
    rows: tickets.map(t => ({
      ...t,
      submittedAt: fmtDate(t.submittedAt),
    })),
  }], `PropertyPortal_Tickets_${new Date().toISOString().slice(0, 10)}`);
}

async function maintenanceReportToExcel({ summary, byBuilding, byCategory, byTechnician, tickets }) {
  return workbookFromSheets([
    {
      name: "Summary",
      columns: [
        { header: "Metric", key: "metric", width: 32 },
        { header: "Value",  key: "value",  width: 18 },
      ],
      rows: Object.entries(summary).map(([metric, value]) => ({ metric, value })),
    },
    {
      name: "By building",
      columns: [
        { header: "Building",   key: "building" },
        { header: "Open",       key: "open" },
        { header: "Completed",  key: "completed" },
        { header: "Avg SLA (h)", key: "avgSla" },
        { header: "Avg rating", key: "avgRating" },
      ],
      rows: byBuilding,
    },
    {
      name: "By category",
      columns: [
        { header: "Category",  key: "category" },
        { header: "Total",     key: "total" },
        { header: "Completed", key: "completed" },
      ],
      rows: byCategory,
    },
    {
      name: "By technician",
      columns: [
        { header: "Technician", key: "technician" },
        { header: "Open",       key: "open" },
        { header: "Completed",  key: "completed" },
        { header: "Avg rating", key: "avgRating" },
      ],
      rows: byTechnician,
    },
    {
      name: "Tickets",
      columns: [
        { header: "Ticket",      key: "id" },
        { header: "Submitted",   key: "submittedAt" },
        { header: "Category",    key: "category" },
        { header: "Building",    key: "buildingId" },
        { header: "Tenant",      key: "tenantName" },
        { header: "Status",      key: "status" },
        { header: "Technician",  key: "technicianName" },
        { header: "Rating",      key: "rating" },
      ],
      rows: (tickets || []).map(t => ({
        ...t,
        submittedAt: fmtDate(t.submittedAt),
      })),
    },
  ], `PropertyPortal_Maintenance_Report_${new Date().toISOString().slice(0, 10)}`);
}

async function tenantProfileToExcel(tenant, docs, tickets) {
  return workbookFromSheets([
    {
      name: "Profile",
      columns: [
        { header: "Field", key: "field", width: 22 },
        { header: "Value", key: "value", width: 44 },
      ],
      rows: [
        { field: "Tenant ID",  value: tenant.id },
        { field: "Name",       value: tenant.name },
        { field: "Email",      value: tenant.email },
        { field: "Phone",      value: tenant.phone || "—" },
        { field: "Building",   value: tenant.Building?.name || tenant.buildingId },
        { field: "Unit",       value: tenant.unit },
        { field: "Verified",   value: tenant.is_verified ? "Yes" : "No" },
        { field: "Joined",     value: fmtDate(tenant.created_at) },
      ],
    },
    {
      name: "Documents",
      columns: [
        { header: "Type",       key: "type" },
        { header: "File",       key: "fileName" },
        { header: "Status",     key: "status" },
        { header: "Submitted",  key: "submittedAt" },
        { header: "Note",       key: "note" },
      ],
      rows: (docs || []).map(d => ({ ...d, submittedAt: fmtDate(d.submittedAt) })),
    },
    {
      name: "Tickets",
      columns: [
        { header: "Ticket",     key: "id" },
        { header: "Submitted",  key: "submittedAt" },
        { header: "Category",   key: "category" },
        { header: "Title",      key: "title" },
        { header: "Status",     key: "status" },
        { header: "Technician", key: "technicianName" },
        { header: "Rating",     key: "rating" },
      ],
      rows: (tickets || []).map(t => ({ ...t, submittedAt: fmtDate(t.submittedAt) })),
    },
  ], `PropertyPortal_Tenant_${sanitizeName(tenant.name)}_${tenant.unit}`);
}

// ------------------- PDF -------------------

function pdfStream() {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const chunks = [];
  doc.on("data", c => chunks.push(c));
  return {
    doc,
    finish: () => new Promise((resolve, reject) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.end();
    }),
  };
}

function pdfHeader(doc, title, subtitle) {
  doc.rect(0, 0, doc.page.width, 70).fill("#8C1C13");
  doc.fillColor("#F5EFE8").font("Helvetica-Bold").fontSize(18).text("PropertyPortal", 40, 22);
  doc.font("Helvetica").fontSize(11).text(title, 40, 46);
  if (subtitle) doc.fontSize(9).text(subtitle, 40, 58);
  doc.fillColor("#111").moveDown(4);
}

function pdfTable(doc, columns, rows) {
  const startX = doc.x;
  const startY = doc.y;
  const colWidths = columns.map(c => c.width);
  let x = startX;
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#8C1C13");
  columns.forEach((c, i) => {
    doc.text(c.header, x + 4, startY + 4, { width: colWidths[i] - 8 });
    x += colWidths[i];
  });
  doc.moveTo(startX, startY + 18).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), startY + 18).strokeColor("#8C1C13").stroke();

  let y = startY + 22;
  doc.font("Helvetica").fontSize(9).fillColor("#111");
  rows.forEach(row => {
    if (y > doc.page.height - 60) {
      doc.addPage();
      y = 40;
    }
    let cx = startX;
    const rowHeight = Math.max(
      14,
      ...columns.map((c, i) => doc.heightOfString(String(row[c.key] ?? ""), { width: colWidths[i] - 8 })),
    );
    columns.forEach((c, i) => {
      doc.text(String(row[c.key] ?? ""), cx + 4, y, { width: colWidths[i] - 8 });
      cx += colWidths[i];
    });
    y += rowHeight + 6;
    doc.moveTo(startX, y - 2).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y - 2).strokeColor("#E5D6C2").stroke();
  });
  doc.y = y + 10;
}

async function ticketsToPdf(tickets) {
  const { doc, finish } = pdfStream();
  pdfHeader(doc, `Tickets export — ${tickets.length} record(s)`, new Date().toLocaleString("en-GB"));

  pdfTable(doc, [
    { header: "Ticket",   key: "id",           width: 80 },
    { header: "Date",     key: "submittedAt",  width: 70 },
    { header: "Category", key: "category",     width: 60 },
    { header: "Building", key: "buildingId",   width: 60 },
    { header: "Unit",     key: "unit",         width: 36 },
    { header: "Tenant",   key: "tenantName",   width: 90 },
    { header: "Status",   key: "status",       width: 60 },
    { header: "Technician", key: "technicianName", width: 80 },
    { header: "Rating",   key: "rating",       width: 40 },
  ], tickets.map(t => ({
    ...t,
    submittedAt: t.submittedAt ? new Date(t.submittedAt).toLocaleDateString("en-GB") : "—",
    rating: t.rating ?? "",
    technicianName: t.technicianName || "—",
  })));

  const buffer = await finish();
  return { buffer, filename: `PropertyPortal_Tickets_${new Date().toISOString().slice(0,10)}.pdf` };
}

async function maintenanceReportToPdf({ summary, byBuilding, byCategory, byTechnician, tickets }) {
  const { doc, finish } = pdfStream();
  pdfHeader(doc, "Maintenance report", new Date().toLocaleString("en-GB"));

  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text("Summary").moveDown(0.3);
  pdfTable(doc, [
    { header: "Metric", key: "metric", width: 220 },
    { header: "Value",  key: "value",  width: 80 },
  ], Object.entries(summary).map(([metric, value]) => ({ metric, value })));

  doc.moveDown(0.8).font("Helvetica-Bold").fontSize(12).text("By building").moveDown(0.3);
  pdfTable(doc, [
    { header: "Building",   key: "building",   width: 160 },
    { header: "Open",       key: "open",       width: 60 },
    { header: "Completed",  key: "completed",  width: 80 },
    { header: "Avg SLA (h)", key: "avgSla",    width: 80 },
    { header: "Avg rating", key: "avgRating",  width: 80 },
  ], byBuilding);

  doc.moveDown(0.8).font("Helvetica-Bold").fontSize(12).text("By category").moveDown(0.3);
  pdfTable(doc, [
    { header: "Category",  key: "category",  width: 160 },
    { header: "Total",     key: "total",     width: 80 },
    { header: "Completed", key: "completed", width: 80 },
  ], byCategory);

  doc.moveDown(0.8).font("Helvetica-Bold").fontSize(12).text("By technician").moveDown(0.3);
  pdfTable(doc, [
    { header: "Technician", key: "technician", width: 180 },
    { header: "Open",       key: "open",       width: 60 },
    { header: "Completed",  key: "completed",  width: 80 },
    { header: "Avg rating", key: "avgRating",  width: 80 },
  ], byTechnician);

  const buffer = await finish();
  return { buffer, filename: `PropertyPortal_Maintenance_Report_${new Date().toISOString().slice(0,10)}.pdf` };
}

async function tenantProfileToPdf(tenant, docs, tickets) {
  const { doc, finish } = pdfStream();
  pdfHeader(doc, `Tenant profile — ${tenant.name}`, new Date().toLocaleString("en-GB"));

  doc.font("Helvetica").fontSize(10).fillColor("#333");
  const info = [
    ["Tenant ID", tenant.id],
    ["Email",     tenant.email],
    ["Phone",     tenant.phone || "—"],
    ["Building",  tenant.Building?.name || tenant.buildingId],
    ["Unit",      tenant.unit],
    ["Verified",  tenant.is_verified ? "Yes" : "No"],
    ["Joined",    fmtDate(tenant.created_at)],
  ];
  info.forEach(([k, v]) => {
    doc.font("Helvetica-Bold").text(`${k}: `, { continued: true }).font("Helvetica").text(String(v ?? ""));
  });
  doc.moveDown(0.8);

  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text("Documents").moveDown(0.3);
  pdfTable(doc, [
    { header: "Type",      key: "type",        width: 130 },
    { header: "File",      key: "fileName",    width: 170 },
    { header: "Status",    key: "status",      width: 80 },
    { header: "Submitted", key: "submittedAt", width: 80 },
  ], (docs || []).map(d => ({ ...d, submittedAt: fmtDate(d.submittedAt) })));

  doc.moveDown(0.5).font("Helvetica-Bold").fontSize(12).text("Maintenance history").moveDown(0.3);
  pdfTable(doc, [
    { header: "Ticket",     key: "id",             width: 90 },
    { header: "Date",       key: "submittedAt",    width: 70 },
    { header: "Category",   key: "category",       width: 70 },
    { header: "Title",      key: "title",          width: 170 },
    { header: "Status",     key: "status",         width: 70 },
    { header: "Rating",     key: "rating",         width: 40 },
  ], (tickets || []).map(t => ({
    ...t,
    submittedAt: fmtDate(t.submittedAt),
    rating: t.rating ?? "",
  })));

  const buffer = await finish();
  return {
    buffer,
    filename: `PropertyPortal_Tenant_${sanitizeName(tenant.name)}_${tenant.unit}.pdf`,
  };
}

module.exports = {
  ticketsToExcel,
  ticketsToPdf,
  maintenanceReportToExcel,
  maintenanceReportToPdf,
  tenantProfileToExcel,
  tenantProfileToPdf,
};
