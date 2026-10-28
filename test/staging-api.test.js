"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const base = process.env.STAGING_API_BASE;
const configured = Boolean(base && process.env.STAGING_ADMIN_EMAIL && process.env.STAGING_ADMIN_PASSWORD && process.env.STAGING_TENANT_EMAIL && process.env.STAGING_TENANT_PASSWORD);

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${payload.error || ""}`);
  return payload;
}

test("staging readiness checks database and storage", { skip: !configured }, async () => {
  const report = await call("GET", "/api/health/ready");
  assert.equal(report.ok, true);
  assert.equal(report.services.database.ok, true);
  assert.equal(report.services.storage.ok, true);
});

test("admin and tenant authentication boundaries", { skip: !configured }, async () => {
  const admin = await call("POST", "/api/auth/admin/login", { body: { email: process.env.STAGING_ADMIN_EMAIL, password: process.env.STAGING_ADMIN_PASSWORD } });
  const tenant = await call("POST", "/api/auth/tenant/login", { body: { email: process.env.STAGING_TENANT_EMAIL, password: process.env.STAGING_TENANT_PASSWORD } });
  assert.ok(admin.token);
  assert.ok(tenant.accessToken);
  await assert.rejects(() => call("GET", "/api/dashboard/stats", { token: tenant.accessToken }));
  await assert.rejects(() => call("GET", "/api/mobile/bootstrap", { token: admin.token }));
});

test("maintenance request creation and admin status update", { skip: !configured }, async () => {
  const admin = await call("POST", "/api/auth/admin/login", { body: { email: process.env.STAGING_ADMIN_EMAIL, password: process.env.STAGING_ADMIN_PASSWORD } });
  const tenant = await call("POST", "/api/auth/tenant/login", { body: { email: process.env.STAGING_TENANT_EMAIL, password: process.env.STAGING_TENANT_PASSWORD } });
  const created = await call("POST", "/api/mobile/maintenance-requests", {
    token: tenant.accessToken,
    body: { category: "Staging test", title: `CI ${Date.now()}`, location: "Test location", description: "Automated staging release gate", preferredTime: "Any" },
  });
  const id = created.request?.id;
  assert.ok(id);
  const updated = await call("PATCH", `/api/dashboard/tickets/${id}`, { token: admin.token, body: { status: "In Progress" } });
  assert.equal(updated.request?.status, "In Progress");
});

test.todo("attachment upload and retrieval requires a dedicated maintenance-attachment API contract");
test.todo("notification triggering requires a staging Expo receipt assertion endpoint");
test.todo("database RLS cross-tenant tests require two dedicated staging tenant accounts");
