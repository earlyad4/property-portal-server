"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RequestMetrics, withTimeout } = require("../lib/operations-service");

test("withTimeout reports a successful timed dependency", async () => {
  const result = await withTimeout("quick", 100, async () => ({ value: 7 }));
  assert.equal(result.ok, true);
  assert.equal(result.value, 7);
  assert.equal(typeof result.latencyMs, "number");
});

test("withTimeout marks a slow dependency unavailable", async () => {
  const result = await withTimeout("slow", 5, () => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
});

test("request metrics calculate server error rate and latency", () => {
  const metrics = new RequestMetrics();
  metrics.samples = [
    { at: Date.now(), status: 200, latencyMs: 10 },
    { at: Date.now(), status: 503, latencyMs: 80 },
  ];
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.requests, 2);
  assert.equal(snapshot.serverErrors, 1);
  assert.equal(snapshot.errorRatePercent, 50);
  assert.equal(snapshot.latencyMs.max, 80);
});
