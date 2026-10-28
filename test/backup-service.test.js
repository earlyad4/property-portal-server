"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { decryptBuffer, encryptBuffer, parseEncryptionKey, sha256 } = require("../lib/backup-service");

test("backup encryption is authenticated and reversible", () => {
  const key = crypto.randomBytes(32);
  const clear = Buffer.from(JSON.stringify({ tenant: "example", secret: "not plaintext" }));
  const encrypted = encryptBuffer(clear, key);
  assert.equal(encrypted.includes(Buffer.from("not plaintext")), false);
  assert.deepEqual(decryptBuffer(encrypted, key), clear);
});

test("backup encryption detects tampering", () => {
  const key = crypto.randomBytes(32);
  const encrypted = encryptBuffer(Buffer.from("important"), key);
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => decryptBuffer(encrypted, key));
});

test("encryption keys accept 32-byte base64 and 64-character hex", () => {
  const key = crypto.randomBytes(32);
  assert.deepEqual(parseEncryptionKey(key.toString("base64")), key);
  assert.deepEqual(parseEncryptionKey(key.toString("hex")), key);
  assert.equal(parseEncryptionKey("too-short"), null);
});

test("sha256 is stable", () => {
  assert.equal(sha256(Buffer.from("property-portal")), "0e63464e3796e967efde14f1dca40f66fd3fa5b4dfe20d9595c2770b8090c73c");
});
