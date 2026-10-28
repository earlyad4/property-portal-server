"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AlertService, parseRecipients, safeDetails } = require("../lib/alert-service");
const { Resend } = require("resend");
const { Webhook } = require("standardwebhooks");

class Query {
  constructor(db) { this.db = db; this.filters = []; this.action = "select"; this.patch = null; this.rows = null; this.max = null; }
  select() { return this; }
  insert(rows) { this.action = "insert"; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch) { this.action = "update"; this.patch = patch; return this; }
  eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
  in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
  contains(key, values) { this.filters.push((row) => values.every((value) => (row[key] || []).includes(value))); return this; }
  order() { return this; }
  limit(value) { this.max = value; return this; }
  matches() { return this.db.rows.filter((row) => this.filters.every((fn) => fn(row))).slice(0, this.max || Infinity); }
  execute() {
    if (this.action === "insert") {
      const inserted = this.rows.map((row) => ({ alert_id: row.alert_id || crypto.randomUUID(), resend_email_ids: [], resend_event_ids: [], retry_count: 0, ...row }));
      this.db.rows.push(...inserted); return inserted;
    }
    if (this.action === "update") {
      const rows = this.matches(); rows.forEach((row) => Object.assign(row, this.patch)); return rows;
    }
    return this.matches();
  }
  async single() { const row = this.execute()[0]; return row ? { data: structuredClone(row), error: null } : { data: null, error: new Error("not found") }; }
  async maybeSingle() { const row = this.execute()[0]; return { data: row ? structuredClone(row) : null, error: null }; }
  then(resolve, reject) { return Promise.resolve({ data: structuredClone(this.execute()), error: null }).then(resolve, reject); }
}

const crypto = require("crypto");
class MemoryAdmin { constructor() { this.rows = []; } from(name) { assert.equal(name, "SystemAlert"); return new Query(this); } }
class FakeClock extends Date { constructor() { super(FakeClock.current); } static current = "2026-08-16T08:00:00.000Z"; }

function setup() {
  FakeClock.current = "2026-08-16T08:00:00.000Z";
  process.env.ALERT_EMAIL_ENABLED = "true";
  process.env.ALERT_EMAIL_FROM = "PropertyPortal Operations <alerts@example.com>";
  process.env.ALERT_EMAIL_TO = "ops@example.com, accounts@example.com, support@example.com, rentals@example.com";
  process.env.ALERT_EMAIL_ESCALATION_TO = "alerts@example.com";
  process.env.RESEND_API_KEY = "re_test_only";
  process.env.RESEND_WEBHOOK_SECRET = "whsec_test_only";
  process.env.PROPERTY_PORTAL_FILES_DIR = "/tmp/property-portal-alert-tests";
  const sent = [];
  const resend = {
    emails: { send: async (message, options) => { sent.push({ message, options }); return { data: { id: `email-${sent.length}` }, error: null }; } },
    webhooks: { verify: ({ payload, headers }) => { if (headers.signature !== "valid") throw new Error("invalid signature"); return JSON.parse(payload); } },
  };
  const admin = new MemoryAdmin();
  const service = new AlertService({ admin, environment: "production", releaseId: "v1.4.0+abc123", resend, clock: FakeClock, setTimer: () => ({ unref() {} }) });
  return { service, admin, sent };
}

const incident = {
  incidentKey: "dependency:database", eventType: "database-unavailable", severity: "critical",
  component: "Supabase database", summary: "Connection failed",
  details: { summary: "Connection failed", password: "do-not-send", authorization: "Bearer abc.def.ghi" },
  recommendedAction: "Check Supabase status", healthStatus: "unhealthy",
};

test("recipient parsing is deterministic", () => {
  assert.deepEqual(parseRecipients(" A@example.com, b@example.com "), ["a@example.com", "b@example.com"]);
});

test("safe diagnostics redact secret-bearing keys and values", () => {
  const safe = safeDetails({ apiKey: "re_supersecret", nested: { password: "hello" }, note: "Bearer eyJabcdef.abcdefghij" });
  assert.equal(safe.apiKey, "[REDACTED]");
  assert.equal(safe.nested.password, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(safe), /supersecret|hello|eyJabcdef/);
});

test("alerts are deduplicated and Resend request is routed to all operations recipients", async () => {
  const { service, sent } = setup();
  const first = await service.createIncident(incident);
  const second = await service.createIncident(incident);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.to.length, 4);
  assert.match(sent[0].message.subject, /CRITICAL.*Supabase database.*v1\.4\.0/);
  assert.doesNotMatch(sent[0].message.text, /do-not-send|Bearer/);
  assert.match(sent[0].options.idempotencyKey, /^property-portal-/);
});

test("critical unresolved incidents escalate after 30 minutes", async () => {
  const { service, sent } = setup();
  await service.createIncident(incident);
  FakeClock.current = "2026-08-16T08:31:00.000Z";
  await service.reconcile();
  assert.equal(sent.length, 2);
  assert.match(sent[1].message.subject, /ESCALATION/);
});

test("recovery sends exactly one recovery email", async () => {
  const { service, sent } = setup();
  await service.createIncident(incident);
  const first = await service.recover(incident.incidentKey, { summary: "restored" });
  const second = await service.recover(incident.incidentKey, { summary: "still restored" });
  assert.equal(first.recovered, true);
  assert.equal(second.recovered, false);
  assert.equal(sent.length, 2);
  assert.match(sent[1].message.subject, /RECOVERY/);
});

test("webhook signature is required and duplicate delivery is idempotent", async () => {
  const { service, admin } = setup();
  const created = await service.createIncident(incident);
  const payload = JSON.stringify({ type: "email.delivered", created_at: FakeClock.current, data: { email_id: created.alert.resend_email_id } });
  await assert.rejects(() => service.processWebhook(payload, { id: "evt-1", timestamp: "1", signature: "invalid" }), /invalid signature/);
  const first = await service.processWebhook(payload, { id: "evt-1", timestamp: "1", signature: "valid" });
  const duplicate = await service.processWebhook(payload, { id: "evt-1", timestamp: "1", signature: "valid" });
  assert.equal(first.processed, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(admin.rows.length, 1);
  assert.equal(admin.rows[0].delivery_status, "delivered");
});

test("official Resend verifier accepts a valid raw-body signature and rejects tampering", () => {
  const secret = `whsec_${crypto.randomBytes(32).toString("base64")}`;
  const verifier = new Resend("re_test_only");
  const signer = new Webhook(secret);
  const id = "evt-cryptographic-verification";
  const timestamp = new Date();
  const payload = JSON.stringify({ type: "email.sent", data: { email_id: "email-1" } });
  const signature = signer.sign(id, timestamp, payload);
  const headers = { id, timestamp: String(Math.floor(timestamp.getTime() / 1000)), signature };
  assert.equal(verifier.webhooks.verify({ payload, headers, webhookSecret: secret }).type, "email.sent");
  assert.throws(() => verifier.webhooks.verify({ payload: `${payload} `, headers, webhookSecret: secret }));
});
