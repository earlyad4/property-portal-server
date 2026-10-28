"use strict";

// Lightweight Expo push sender (no SDK). This records submission health; a
// production notification worker should additionally poll Expo receipts.
let lastPushStatus = {
  configured: true,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  accepted: 0,
  rejected: 0,
};

function getPushStatus() { return { ...lastPushStatus }; }

async function sendExpoPush(tokens, title, body, data) {
  const valid = (tokens || []).filter(t => typeof t === "string" && /^(Exponent|Expo)PushToken\[.+\]$/.test(t));
  if (!valid.length) return { sent: 0 };

  lastPushStatus.lastAttemptAt = new Date().toISOString();
  const messages = valid.map(to => ({ to, title, body, data, sound: "default", priority: "high" }));
  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "accept": "application/json" },
      body: JSON.stringify(messages),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Expo push service returned HTTP ${res.status}`);
    const tickets = Array.isArray(json.data) ? json.data : [];
    const rejected = tickets.filter((ticket) => ticket?.status === "error").length;
    const accepted = Math.max(0, valid.length - rejected);
    lastPushStatus = {
      ...lastPushStatus,
      lastSuccessAt: rejected === valid.length ? lastPushStatus.lastSuccessAt : new Date().toISOString(),
      lastErrorAt: rejected ? new Date().toISOString() : lastPushStatus.lastErrorAt,
      lastError: rejected ? `${rejected} push ticket(s) rejected by Expo` : null,
      accepted,
      rejected,
    };
    return { sent: accepted, rejected, response: json };
  } catch (err) {
    console.warn("[push]", err.message);
    lastPushStatus = { ...lastPushStatus, lastErrorAt: new Date().toISOString(), lastError: err.message, accepted: 0, rejected: valid.length };
    return { sent: 0, error: err.message };
  }
}

module.exports = { getPushStatus, sendExpoPush };
