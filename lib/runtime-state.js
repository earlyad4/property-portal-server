"use strict";

const fs = require("fs/promises");
const path = require("path");

function statePath() {
  return path.resolve(process.env.PROPERTY_PORTAL_FILES_DIR || path.join(__dirname, "..", "runtime-data"), "runtime", "server-state.json");
}

async function writeState(state) {
  const file = statePath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function markRunning(releaseId) {
  let previous = null;
  try { previous = JSON.parse(await fs.readFile(statePath(), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeState({ status: "running", releaseId, processId: process.pid, startedAt: new Date().toISOString() });
  return { previous, uncleanRestart: previous?.status === "running" };
}

async function markStopped(releaseId, signal) {
  await writeState({ status: "stopped", releaseId, signal, stoppedAt: new Date().toISOString() });
}

module.exports = { markRunning, markStopped, statePath };

