"use strict";

function numericVersion(value) {
  const match = String(value || "").match(/(?:^|v)(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function versionBelow(value, minimum) {
  const current = numericVersion(value);
  const required = numericVersion(minimum);
  if (!current || !required) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== required[index]) return current[index] < required[index];
  }
  return false;
}

module.exports = { numericVersion, versionBelow };

