"use strict";

const os = require("os");
const tls = require("tls");

function now() { return new Date().toISOString(); }

function duration(started) {
  return Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 10) / 10;
}

async function withTimeout(label, timeoutMs, work) {
  const started = process.hrtime.bigint();
  const controller = new AbortController();
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: duration(started), ...value };
  } catch (error) {
    return { ok: false, latencyMs: duration(started), error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

function certificateStatus(urlString, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname });
    const timer = setTimeout(() => socket.destroy(new Error("TLS certificate check timed out")), timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate();
      const expiresAt = cert?.valid_to ? new Date(cert.valid_to) : null;
      const daysRemaining = expiresAt ? Math.floor((expiresAt.getTime() - Date.now()) / 86400000) : null;
      socket.end();
      resolve({ expiresAt: expiresAt?.toISOString() || null, daysRemaining });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

class RequestMetrics {
  constructor(limit = 2000) {
    this.limit = limit;
    this.samples = [];
    this.startedAt = now();
  }

  middleware() {
    return (req, res, next) => {
      const started = process.hrtime.bigint();
      res.once("finish", () => {
        const sample = {
          at: Date.now(),
          method: req.method,
          route: req.route?.path || req.path,
          status: res.statusCode,
          latencyMs: duration(started),
        };
        this.samples.push(sample);
        if (this.samples.length > this.limit) this.samples.splice(0, this.samples.length - this.limit);
      });
      next();
    };
  }

  snapshot(windowMinutes = 15) {
    const cutoff = Date.now() - windowMinutes * 60000;
    const recent = this.samples.filter((sample) => sample.at >= cutoff);
    const latencies = recent.map((sample) => sample.latencyMs).sort((a, b) => a - b);
    const percentile = (p) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] : 0;
    const errors = recent.filter((sample) => sample.status >= 500).length;
    return {
      windowMinutes,
      requests: recent.length,
      serverErrors: errors,
      errorRatePercent: recent.length ? Math.round((errors / recent.length) * 10000) / 100 : 0,
      latencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: latencies.at(-1) || 0 },
      measuredSince: this.startedAt,
    };
  }
}

class OperationsService {
  constructor({ admin, supabaseUrl, backupService, alertService, releaseId, environment, getWebSocketCount, getPushStatus }) {
    this.admin = admin;
    this.supabaseUrl = supabaseUrl;
    this.backupService = backupService;
    this.alertService = alertService;
    this.releaseId = releaseId;
    this.environment = environment;
    this.getWebSocketCount = getWebSocketCount;
    this.getPushStatus = getPushStatus;
    this.metrics = new RequestMetrics();
    this.lastReport = null;
    this.monitorTimer = null;
    this.previousStatus = null;
  }

  requestMetricsMiddleware() { return this.metrics.middleware(); }

  async checks({ detailed = false } = {}) {
    const timeoutMs = Number(process.env.HEALTH_CHECK_TIMEOUT_MS || 4000);
    const database = await withTimeout("database", timeoutMs, async (signal) => {
      const result = await this.admin.from("Building").select("id", { count: "exact", head: true }).abortSignal(signal);
      if (result.error) throw result.error;
      return { recordsVisible: result.count ?? null };
    });
    const storage = await withTimeout("Supabase Storage", timeoutMs, async () => {
      const result = await this.admin.storage.listBuckets();
      if (result.error) throw result.error;
      const names = (result.data || []).map((bucket) => bucket.name);
      const required = (process.env.REQUIRED_STORAGE_BUCKETS || "building-photos").split(",").map((value) => value.trim()).filter(Boolean);
      const missing = required.filter((name) => !names.includes(name));
      if (missing.length) throw new Error(`Required bucket(s) missing: ${missing.join(", ")}`);
      return { bucketCount: names.length, requiredBucketsPresent: required };
    });
    const localBackup = await withTimeout("local backup target", timeoutMs, () => this.backupService.checkLocalTarget());
    if (localBackup.ok && localBackup.ok === false) localBackup.ok = false;
    const certificateTarget = process.env.PUBLIC_BASE_URL || this.supabaseUrl;
    const certificate = await withTimeout("TLS certificate", timeoutMs, async () => ({
      target: new URL(certificateTarget).hostname,
      ...await certificateStatus(certificateTarget, timeoutMs),
    }));
    if (certificate.ok && certificate.daysRemaining !== null && certificate.daysRemaining < 14) {
      certificate.ok = false;
      certificate.error = `TLS certificate expires in ${certificate.daysRemaining} days`;
    }

    const required = [database, storage];
    const healthyRequired = required.every((item) => item.ok);
    const warnings = [];
    if (!this.backupService.enabled) warnings.push("Automated recovery backups are not enabled.");
    if (!this.backupService.key) warnings.push("Backup encryption key is not configured.");
    if (!localBackup.ok) warnings.push(`Local backup target is unavailable: ${localBackup.error}`);
    if (!certificate.ok) warnings.push(`TLS certificate check failed: ${certificate.error}`);
    if (!this.alertService.isConfigured()) warnings.push("Resend alert email is not configured; automated escalation is unavailable.");

    const report = {
      status: healthyRequired ? (warnings.length ? "degraded" : "healthy") : "unhealthy",
      ready: healthyRequired,
      checkedAt: now(),
      environment: this.environment,
      releaseId: this.releaseId,
      uptimeSeconds: Math.floor(process.uptime()),
      services: { database, storage, localBackup, certificate },
      backup: this.backupService.getStatus(),
      alerts: this.alertService.status(),
      metrics: this.metrics.snapshot(),
      realtime: { connectedClients: this.getWebSocketCount() },
      mobile: { push: this.getPushStatus ? this.getPushStatus() : { configured: false } },
      resources: {
        process: process.memoryUsage(),
        system: {
          hostname: os.hostname(),
          platform: os.platform(),
          cpuCount: os.cpus().length,
          loadAverage: os.loadavg(),
          freeMemoryBytes: os.freemem(),
          totalMemoryBytes: os.totalmem(),
        },
      },
      warnings,
    };
    if (detailed) report.diagnosis = this.diagnosis(report);
    this.lastReport = report;
    return report;
  }

  diagnosis(report) {
    const tips = [];
    if (!report.services.database.ok) tips.push({ component: "Database", cause: report.services.database.error, action: "Check the Supabase project status, database credentials, connection limits, and migrations." });
    if (!report.services.storage.ok) tips.push({ component: "Supabase Storage", cause: report.services.storage.error, action: "Check Supabase Storage availability, service-role access, bucket existence, and storage quotas." });
    if (!report.services.localBackup.ok) tips.push({ component: "Local backup", cause: report.services.localBackup.error, action: "Confirm the server/backup worker can write to LOCAL_BACKUP_DIR and that the mounted common share has free space." });
    if (!report.services.certificate.ok) tips.push({ component: "TLS", cause: report.services.certificate.error, action: "Check DNS, outbound port 443, certificate renewal, and the configured SUPABASE_URL." });
    if (!report.backup.enabled) tips.push({ component: "Backups", cause: "Scheduled backup is disabled", action: "Configure BACKUP_ENABLED, LOCAL_BACKUP_DIR, BACKUP_ENCRYPTION_KEY, and the private cloud backup bucket." });
    if (report.backup.lastError) tips.push({ component: "Last backup", cause: report.backup.lastError, action: "Review server logs, database connectivity, storage access, disk space, and encryption-key configuration; then run a manual backup." });
    if (!report.alerts.configured) tips.push({ component: "Alerting", cause: "Resend email delivery is not configured", action: "Set the Railway Resend alert variables, verify the sender domain, configure the signed webhook, and run the real delivery test." });
    if (report.mobile?.push?.lastError) tips.push({ component: "Mobile notifications", cause: report.mobile.push.lastError, action: "Inspect Expo push tickets/receipts, remove invalid tokens, and confirm production notification credentials." });
    if (report.metrics.errorRatePercent >= 2) tips.push({ component: "API", cause: `${report.metrics.errorRatePercent}% server-error rate`, action: "Review recent server logs by correlation/request ID and inspect the slowest or failing endpoints." });
    if (!tips.length) tips.push({ component: "System", cause: "No active fault detected", action: "Continue monitoring. A green status confirms only the checks and timestamp shown." });
    return tips;
  }

  async sendAlert(payload = {}) {
    return this.alertService.createIncident({
      incidentKey: payload.incidentKey || `${payload.event || "operations"}:${payload.component || "server"}`,
      eventType: payload.event || "operations-alert",
      severity: payload.severity || "critical",
      component: payload.component || "PropertyPortal server",
      summary: payload.message || payload.error || payload.event || "Operational incident detected",
      details: payload,
      recommendedAction: payload.recommendedAction,
      healthStatus: payload.healthStatus || this.lastReport?.status || "unknown",
      recipients: payload.recipients,
    }, { force: Boolean(payload.force) });
  }

  async evaluateIncidents(report) {
    const memoryUsedPercent = report.resources.system.totalMemoryBytes
      ? Math.round((1 - report.resources.system.freeMemoryBytes / report.resources.system.totalMemoryBytes) * 10000) / 100
      : 0;
    const loadPerCpu = report.resources.system.cpuCount ? report.resources.system.loadAverage[0] / report.resources.system.cpuCount : 0;
    const backupAgeHours = report.backup.lastSuccessAt ? (Date.now() - new Date(report.backup.lastSuccessAt).getTime()) / 3600000 : Infinity;
    const candidates = [
      { key: "health:readiness", bad: !report.ready, severity: "critical", event: "server-readiness-failed", component: "Server readiness", summary: `Readiness is ${report.status}`, action: "Open the System health panel and restore failed required dependencies before routing new traffic." },
      { key: "dependency:database", bad: !report.services.database.ok, severity: "critical", event: "supabase-database-unavailable", component: "Supabase database", summary: report.services.database.error, action: "Check Supabase database status, credentials, connection limits, and the latest migration." },
      { key: "dependency:storage", bad: !report.services.storage.ok, severity: "critical", event: "supabase-storage-unavailable", component: "Supabase Storage", summary: report.services.storage.error, action: "Check Supabase Storage status, required private buckets, quotas, and service-role permissions." },
      { key: "dependency:local-backup", bad: !report.services.localBackup.ok, severity: "critical", event: "local-backup-target-unavailable", component: "Local backup share", summary: report.services.localBackup.error, action: "Restore the mounted runtime-data volume/share and confirm capacity and write permission." },
      { key: "backup:last-failure", bad: Boolean(report.backup.lastError), severity: "critical", event: "backup-failed", component: "Backup and cloud mirror", summary: report.backup.lastError, action: "Inspect the backup manifest and logs, restore local/cloud access, rerun the backup, then verify it." },
      { key: "tls:expiry", bad: !report.services.certificate.ok, severity: "critical", event: "tls-certificate-warning", component: "TLS certificate", summary: report.services.certificate.error, action: "Renew or replace the certificate and verify HTTPS from an external network before expiry." },
      { key: "api:5xx-rate", bad: report.metrics.requests >= Number(process.env.ALERT_ERROR_RATE_MIN_REQUESTS || 20) && report.metrics.errorRatePercent >= Number(process.env.ALERT_ERROR_RATE_THRESHOLD_PERCENT || 5), severity: "critical", event: "api-error-rate-high", component: "API", summary: `${report.metrics.errorRatePercent}% 5xx rate across ${report.metrics.requests} requests`, action: "Correlate failing requests by request ID, inspect the affected release, and roll back if the release caused the increase." },
      { key: "resources:saturation", bad: memoryUsedPercent >= Number(process.env.ALERT_MEMORY_USED_THRESHOLD_PERCENT || 90) || loadPerCpu >= Number(process.env.ALERT_LOAD_PER_CPU_THRESHOLD || 1.5), severity: "critical", event: "server-resource-saturation", component: "Railway server resources", summary: `${memoryUsedPercent}% memory used; one-minute load per CPU ${Math.round(loadPerCpu * 100) / 100}`, action: "Inspect Railway CPU/memory graphs, traffic and recent releases; scale or roll back before the process is exhausted." },
      { key: "backup:stale", bad: report.backup.enabled && backupAgeHours >= Number(process.env.BACKUP_MAX_AGE_HOURS || 26), severity: "critical", event: "backup-overdue", component: "Backup schedule", summary: Number.isFinite(backupAgeHours) ? `Last successful backup is ${Math.round(backupAgeHours * 10) / 10} hours old` : "No successful backup is recorded", action: "Run and verify a backup, restore scheduled execution, and confirm both local and Supabase Storage copies." },
    ];
    for (const item of candidates) {
      if (item.bad) {
        await this.alertService.createIncident({ incidentKey: item.key, eventType: item.event, severity: item.severity, component: item.component, summary: item.summary, details: { summary: item.summary }, recommendedAction: item.action, healthStatus: report.status }).catch(() => {});
      } else {
        await this.alertService.recover(item.key, { summary: `${item.component} check returned to normal`, healthStatus: report.status }).catch(() => {});
      }
    }
  }

  startMonitoring() {
    const intervalMs = Number(process.env.MONITOR_INTERVAL_MS || 30000);
    const run = async () => {
      try {
        const report = await this.checks({ detailed: true });
        if (this.previousStatus && report.status !== this.previousStatus && report.status !== "healthy") {
          await this.sendAlert({ incidentKey: "health:status-transition", event: "health-status-changed", severity: report.status === "unhealthy" ? "critical" : "warning", component: "Overall system health", previousStatus: this.previousStatus, status: report.status, healthStatus: report.status, warnings: report.warnings, message: `Health changed from ${this.previousStatus} to ${report.status}` }).catch(() => {});
        } else if (report.status === "healthy") {
          await this.alertService.recover("health:status-transition", { summary: "Overall system health returned to healthy" }).catch(() => {});
        }
        await this.evaluateIncidents(report);
        await this.alertService.reconcile();
        this.previousStatus = report.status;
      } catch (error) {
        console.error("[operations] monitoring check failed:", error.message);
        await this.alertService.createIncident({ incidentKey: "monitor:execution", eventType: "monitor-execution-failed", severity: "critical", component: "Operations monitor", summary: error.message, details: { summary: error.message }, recommendedAction: "Inspect the Railway process and Supabase connectivity; restore the monitoring loop.", healthStatus: "unknown" }).catch(() => {});
      }
    };
    run();
    this.monitorTimer = setInterval(run, intervalMs);
    this.monitorTimer.unref?.();
  }

  stopMonitoring() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }
}

module.exports = { OperationsService, RequestMetrics, withTimeout };
