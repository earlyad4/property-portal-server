"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { Resend } = require("resend");

const ALLOWED_EVENTS = new Set([
  "email.sent", "email.delivered", "email.failed", "email.bounced", "email.delivery_delayed",
]);
const SENSITIVE_KEY = /(password|passwd|secret|token|api.?key|authorization|cookie|jwt|credential|connection.?string)/i;
const SENSITIVE_VALUE = /(bearer\s+[a-z0-9._~+/=-]+|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}|re_[a-zA-Z0-9_-]{10,}|whsec_[a-zA-Z0-9_+/=-]{10,}|postgres(?:ql)?:\/\/[^\s]+)/gi;

function nowIso(clock = Date) { return new clock().toISOString(); }
function parseRecipients(value) {
  return String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}
function redactText(value) {
  return String(value ?? "").replace(SENSITIVE_VALUE, "[REDACTED]").slice(0, 4000);
}
function safeDetails(value, depth = 0) {
  if (depth > 5) return "[TRUNCATED]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeDetails(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, child]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : safeDetails(child, depth + 1),
    ]));
  }
  return redactText(value);
}
function dubaiTime(iso) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "long",
  }).format(new Date(iso));
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function deliveryFromEvent(type) {
  return ({
    "email.sent": "sent", "email.delivered": "delivered", "email.failed": "failed",
    "email.bounced": "bounced", "email.delivery_delayed": "delayed",
  })[type];
}

class AlertService {
  constructor({ admin, environment, releaseId, resend, clock = Date, setTimer = setTimeout }) {
    this.admin = admin;
    this.environment = environment;
    this.releaseId = releaseId;
    this.clock = clock;
    this.setTimer = setTimer;
    this.enabled = process.env.ALERT_EMAIL_ENABLED === "true";
    this.from = process.env.ALERT_EMAIL_FROM || "";
    this.recipients = parseRecipients(process.env.ALERT_EMAIL_TO);
    this.escalationRecipients = parseRecipients(process.env.ALERT_EMAIL_ESCALATION_TO);
    this.webhookSecret = process.env.RESEND_WEBHOOK_SECRET || "";
    this.reminderMs = Number(process.env.ALERT_REMINDER_MS || 15 * 60 * 1000);
    this.escalationMs = Number(process.env.ALERT_ESCALATION_MS || 30 * 60 * 1000);
    this.retryMs = Number(process.env.ALERT_EMAIL_RETRY_DELAY_MS || 60 * 1000);
    this.resend = resend || (process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null);
    this.journalPath = path.resolve(process.env.PROPERTY_PORTAL_FILES_DIR || path.join(__dirname, "..", "runtime-data"), "history", "system-alerts.ndjson");
    this.lastDelivery = { configured: this.isConfigured(), sentAt: null, ok: null, error: null };
  }

  isConfigured() {
    return Boolean(this.enabled && this.from && this.recipients.length && (this.resend || process.env.RESEND_API_KEY));
  }

  status() { return { ...this.lastDelivery, recipients: this.recipients }; }

  async journal(event, alert) {
    const entry = safeDetails({ at: nowIso(this.clock), event, alertId: alert?.alert_id, incidentKey: alert?.incident_key, severity: alert?.severity, status: alert?.status, deliveryStatus: alert?.delivery_status, providerEmailId: alert?.resend_email_id });
    await fs.mkdir(path.dirname(this.journalPath), { recursive: true, mode: 0o700 });
    await fs.appendFile(this.journalPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async listRecent(limit = 50) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const result = await this.admin.from("SystemAlert").select("*").order("created_at", { ascending: false }).limit(safeLimit);
    if (result.error) throw result.error;
    return result.data || [];
  }

  async findActive(incidentKey) {
    const result = await this.admin.from("SystemAlert").select("*")
      .eq("incident_key", incidentKey).eq("environment", this.environment)
      .in("status", ["open", "acknowledged", "failed_delivery"])
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (result.error) throw result.error;
    return result.data || null;
  }

  buildMessage(alert, kind = "initial") {
    const label = kind === "recovery" ? "RECOVERY" : kind === "reminder" ? "REMINDER" : kind === "escalation" ? "ESCALATION" : alert.severity.toUpperCase();
    const detected = dubaiTime(alert.created_at);
    const details = JSON.stringify(safeDetails(alert.diagnostic_details), null, 2);
    const subject = `[PropertyPortal ${label}] ${alert.affected_component} — ${this.environment} — ${this.releaseId}`;
    const lines = [
      `Environment: ${this.environment}`,
      `Immutable release ID: ${this.releaseId}`,
      `Incident severity: ${alert.severity}`,
      `Affected service: ${alert.affected_component}`,
      `Detected (Asia/Dubai): ${detected}`,
      `Technical summary: ${redactText(alert.diagnostic_details?.summary || alert.event_type)}`,
      `Safe recommended action: ${redactText(alert.recommended_action)}`,
      `Health endpoint status: ${alert.health_endpoint_status}`,
      `Alert/incident ID: ${alert.alert_id}`,
      "",
      "Safe diagnostic details:",
      details,
      "",
      "This operational email intentionally excludes credentials, tenant data, and attachments.",
    ];
    const text = lines.join("\n");
    const html = `<h2>${escapeHtml(subject)}</h2><pre style="white-space:pre-wrap;font-family:system-ui">${escapeHtml(text)}</pre>`;
    return { subject, text, html };
  }

  async createIncident(input, { force = false } = {}) {
    const incidentKey = redactText(input.incidentKey || `${input.eventType}:${input.component}`);
    if (!force) {
      const existing = await this.findActive(incidentKey);
      if (existing) return { alert: existing, deduplicated: true };
    }
    const createdAt = nowIso(this.clock);
    const row = {
      incident_key: incidentKey,
      event_type: redactText(input.eventType),
      severity: ["info", "warning", "critical"].includes(input.severity) ? input.severity : "warning",
      status: "open",
      delivery_status: "queued",
      environment: this.environment,
      release_id: this.releaseId,
      affected_component: redactText(input.component),
      diagnostic_details: safeDetails(input.details || { summary: input.summary }),
      recommended_action: redactText(input.recommendedAction || "Review the System health panel and the server logs using the incident ID."),
      health_endpoint_status: redactText(input.healthStatus || "unknown"),
      recipients: input.recipients || this.recipients,
      created_at: createdAt,
      updated_at: createdAt,
    };
    const result = await this.admin.from("SystemAlert").insert(row).select("*").single();
    if (result.error) throw result.error;
    await this.journal("incident-created", result.data).catch(() => {});
    try {
      return { alert: await this.deliver(result.data, "initial"), deduplicated: false };
    } catch (error) {
      this.scheduleFallback(result.data.alert_id);
      throw error;
    }
  }

  async deliver(alert, kind = "initial", recipients = alert.recipients) {
    if (!this.isConfigured()) throw new Error("Resend alert email is not fully configured on the server");
    const recipientList = [...new Set(recipients)].filter(Boolean);
    const message = this.buildMessage(alert, kind);
    const idempotencyKey = `property-portal-${alert.alert_id}-${kind}-${alert.retry_count || 0}`.slice(0, 256);
    const response = await this.resend.emails.send({
      from: this.from, to: recipientList, subject: message.subject, text: message.text, html: message.html,
      headers: { "X-Property-Portal-Incident-ID": alert.alert_id },
      tags: [{ name: "incident_id", value: alert.alert_id.replace(/-/g, "_") }, { name: "environment", value: this.environment.replace(/[^a-zA-Z0-9_-]/g, "_") }],
    }, { idempotencyKey });
    if (response.error || !response.data?.id) {
      const messageText = redactText(response.error?.message || "Resend did not return an email ID");
      await this.admin.from("SystemAlert").update({ status: "failed_delivery", delivery_status: "failed", updated_at: nowIso(this.clock), diagnostic_details: safeDetails({ ...alert.diagnostic_details, deliveryError: messageText }) }).eq("alert_id", alert.alert_id);
      this.lastDelivery = { configured: true, sentAt: nowIso(this.clock), ok: false, error: messageText };
      throw new Error(messageText);
    }
    const sentAt = nowIso(this.clock);
    const updates = { resend_email_id: response.data.id, resend_email_ids: [...new Set([...(alert.resend_email_ids || []), response.data.id])], recipients: recipientList, sent_at: sentAt, delivery_status: "sent", status: alert.status === "failed_delivery" ? "open" : alert.status, updated_at: sentAt };
    if (kind === "reminder") updates.reminder_sent_at = sentAt;
    if (kind === "escalation") updates.escalation_sent_at = sentAt;
    const saved = await this.admin.from("SystemAlert").update(updates).eq("alert_id", alert.alert_id).select("*").single();
    if (saved.error) throw saved.error;
    await this.journal(`email-${kind}`, saved.data).catch(() => {});
    this.lastDelivery = { configured: true, sentAt, ok: true, error: null, providerEmailId: response.data.id };
    return saved.data;
  }

  scheduleFallback(alertId) {
    const timer = this.setTimer(() => this.retryFailed(alertId).catch((error) => console.error("[alerts] fallback delivery failed:", redactText(error.message))), this.retryMs);
    timer?.unref?.();
  }

  async retryFailed(alertId) {
    const result = await this.admin.from("SystemAlert").select("*").eq("alert_id", alertId).single();
    if (result.error || !result.data || result.data.delivery_status !== "failed" || result.data.retry_count >= 1) return null;
    const count = result.data.retry_count + 1;
    await this.admin.from("SystemAlert").update({ retry_count: count, updated_at: nowIso(this.clock) }).eq("alert_id", alertId);
    return this.deliver({ ...result.data, retry_count: count }, "retry");
  }

  async reconcile() {
    const result = await this.admin.from("SystemAlert").select("*").in("status", ["open", "acknowledged", "failed_delivery"]).eq("environment", this.environment);
    if (result.error) throw result.error;
    const current = new this.clock().getTime();
    for (const alert of result.data || []) {
      const age = current - new Date(alert.created_at).getTime();
      if (alert.severity === "critical" && age >= this.escalationMs && !alert.escalation_sent_at) {
        await this.deliver(alert, "escalation", [...new Set([...alert.recipients, ...this.escalationRecipients])]).catch(() => {});
      } else if (age >= this.reminderMs && !alert.reminder_sent_at) {
        await this.deliver(alert, "reminder").catch(() => {});
      }
    }
  }

  async recover(incidentKey, details = {}) {
    const active = await this.findActive(incidentKey);
    if (!active) return { recovered: false };
    const at = nowIso(this.clock);
    const updated = await this.admin.from("SystemAlert").update({ status: "recovered", recovery_at: at, updated_at: at, diagnostic_details: safeDetails({ ...active.diagnostic_details, recovery: details }) }).eq("alert_id", active.alert_id).select("*").single();
    if (updated.error) throw updated.error;
    const delivered = await this.deliver(updated.data, "recovery");
    return { recovered: true, alert: delivered };
  }

  async acknowledge(alertId, adminId, note) {
    const at = nowIso(this.clock);
    const result = await this.admin.from("SystemAlert").update({ status: "acknowledged", acknowledged_at: at, acknowledged_by: adminId, acknowledgement_note: redactText(note || "Acknowledged in desktop health panel"), updated_at: at }).eq("alert_id", alertId).in("status", ["open", "failed_delivery"]).select("*").single();
    if (result.error) throw result.error;
    return result.data;
  }

  async processWebhook(payload, headers) {
    if (!this.resend || !this.webhookSecret) throw new Error("Resend webhook verification is not configured");
    const event = this.resend.webhooks.verify({ payload, headers, webhookSecret: this.webhookSecret });
    if (!ALLOWED_EVENTS.has(event.type)) return { ignored: true };
    const eventId = String(headers.id || "");
    const providerId = event.data?.email_id;
    if (!eventId || !providerId) throw new Error("Resend webhook is missing identifiers");
    const lookup = await this.admin.from("SystemAlert").select("*").contains("resend_email_ids", [providerId]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (lookup.error) throw lookup.error;
    if (!lookup.data) return { ignored: true, unmatched: true };
    if ((lookup.data.resend_event_ids || []).includes(eventId)) return { duplicate: true, alertId: lookup.data.alert_id };
    const delivery = deliveryFromEvent(event.type);
    const failed = delivery === "failed" || delivery === "bounced";
    const details = failed ? safeDetails({ ...lookup.data.diagnostic_details, providerDeliveryFailure: event.data?.failed || event.data?.bounce || event.type }) : lookup.data.diagnostic_details;
    const update = {
      delivery_status: delivery,
      status: failed ? "failed_delivery" : lookup.data.status,
      resend_event_ids: [...(lookup.data.resend_event_ids || []), eventId],
      diagnostic_details: details,
      updated_at: nowIso(this.clock),
    };
    const saved = await this.admin.from("SystemAlert").update(update).eq("alert_id", lookup.data.alert_id).select("*").single();
    if (saved.error) throw saved.error;
    await this.journal(`webhook-${event.type}`, saved.data).catch(() => {});
    if (failed && lookup.data.retry_count < 1) this.scheduleFallback(lookup.data.alert_id);
    return { processed: true, alert: saved.data };
  }
}

module.exports = { AlertService, parseRecipients, redactText, safeDetails, deliveryFromEvent };
