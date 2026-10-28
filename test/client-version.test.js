"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { numericVersion, versionBelow } = require("../lib/client-version");

test("release identifiers expose semantic client versions", () => {
  assert.deepEqual(numericVersion("v1.4.2+abc123"), [1, 4, 2]);
  assert.deepEqual(numericVersion("property-portal-v2.0.0"), [2, 0, 0]);
});

test("old clients are rejected while current and newer clients remain compatible", () => {
  assert.equal(versionBelow("v1.3.9", "1.4.0"), true);
  assert.equal(versionBelow("v1.4.0+build", "1.4.0"), false);
  assert.equal(versionBelow("v2.0.0", "1.4.0"), false);
});

