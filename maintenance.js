// Deployment source: maintenance-agent.
"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_TIMEOUT_MS = 12 * 1000;

function intEnv(name, fallback, minimum = 1) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function parseTargets(raw = process.env.MONITORS_JSON || "[]") {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`MONITORS_JSON is invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("MONITORS_JSON must be an array");
  return parsed.map((target, index) => {
    if (!target || typeof target !== "object") throw new Error(`Monitor ${index + 1} must be an object`);
    if (!target.id || !target.name || !target.url) throw new Error(`Monitor ${index + 1} requires id, name and url`);
    const url = new URL(target.url);
    if (url.protocol !== "https:") throw new Error(`Monitor ${target.id} must use HTTPS`);
    return {
      id: String(target.id),
      name: String(target.name),
      url: url.toString(),
      expectWhatsappReady: Boolean(target.expectWhatsappReady),
      maxLatencyMs: Number.isFinite(Number(target.maxLatencyMs)) ? Number(target.maxLatencyMs) : null,
      recoveryUrl: target.recoveryUrl ? new URL(target.recoveryUrl).toString() : null,
    };
  });
}

function classifyFailure({ status, message = "" }) {
  const text = String(message).toLowerCase();
  if (/duplicate name|validationfault|invalid_argument|unable to parse range|invalid json|not valid json|mapping|undefined/.test(text)) {
    return { kind: "deterministic", recoverable: false };
  }
  if (/auth|qr|not authenticated|session not ready|disconnected/.test(text)) {
    return { kind: "authentication", recoverable: false };
  }
  if ([408, 425, 429, 500, 502, 503, 504].includes(Number(status)) || /timeout|fetch failed|econnreset|econnrefused/.test(text)) {
    return { kind: "transient", recoverable: true };
  }
  return { kind: "unknown", recoverable: false };
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch (_) { return "{}"; }
}

function createAgent(options = {}) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  const config = {
    intervalMs: options.intervalMs || intEnv("CHECK_INTERVAL_MS", DEFAULT_INTERVAL_MS, 60_000),
    timeoutMs: options.timeoutMs || intEnv("CHECK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1_000),
    failureThreshold: options.failureThreshold || intEnv("FAILURE_THRESHOLD", DEFAULT_FAILURE_THRESHOLD, 1),
    recoveryCooldownMs: options.recoveryCooldownMs || intEnv("RECOVERY_COOLDOWN_MS", 30 * 60 * 1000, 60_000),
    makeHeartbeatMaxAgeMs: options.makeHeartbeatMaxAgeMs || intEnv("MAKE_HEARTBEAT_MAX_AGE_MS", 15 * 60 * 1000, 60_000),
    adminToken: options.adminToken ?? process.env.ADMIN_TOKEN,
    eventSecret: options.eventSecret ?? process.env.EVENT_SECRET,
    alertWebhookUrl: options.alertWebhookUrl ?? process.env.ALERT_WEBHOOK_URL,
    whatsappBridgeUrl: options.whatsappBridgeUrl ?? process.env.WHATSAPP_BRIDGE_URL,
    alertChatId: options.alertChatId ?? process.env.ALERT_CHAT_ID,
    targets: options.targets || parseTargets(),
    stateFile: options.stateFile ?? process.env.STATE_FILE,
  };

  const state = {
    startedAt: new Date().toISOString(),
    lastCheckAt: null,
    lastMakeHeartbeatAt: null,
    targets: {},
    incidents: {},
    events: [],
  };

  function restoreState() {
    if (!config.stateFile) return;
    try {
      const saved = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
      if (saved && typeof saved === "object") {
        state.lastMakeHeartbeatAt = saved.lastMakeHeartbeatAt || null;
        state.targets = saved.targets || {};
        state.incidents = saved.incidents || {};
      }
    } catch (error) {
      if (error.code !== "ENOENT") console.error("State restore failed:", error.message);
    }
  }

  function persistState() {
    if (!config.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
      const temporary = `${config.stateFile}.tmp`;
      fs.writeFileSync(temporary, safeJson({
        lastMakeHeartbeatAt: state.lastMakeHeartbeatAt,
        targets: state.targets,
        incidents: state.incidents,
      }));
      fs.renameSync(temporary, config.stateFile);
    } catch (error) {
      console.error("State persistence failed:", error.message);
    }
  }

  function addEvent(event) {
    state.events.unshift({ at: new Date().toISOString(), ...event });
    state.events = state.events.slice(0, 100);
    console.log("MAINTENANCE_EVENT", safeJson(event));
  }

  async function sendAlert(payload) {
    addEvent({ type: "alert", ...payload });
    const body = {
      source: "BTSA Maintenance Agent",
      ...payload,
      timestamp: new Date().toISOString(),
    };

    if (config.alertWebhookUrl) {
      const response = await fetch(config.alertWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: safeJson(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) throw new Error(`Alert webhook returned HTTP ${response.status}`);
      return "webhook";
    }

    if (config.whatsappBridgeUrl && config.alertChatId) {
      const response = await fetch(`${config.whatsappBridgeUrl.replace(/\/$/, "")}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: safeJson({ chatId: config.alertChatId, text: payload.message }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) throw new Error(`WhatsApp bridge returned HTTP ${response.status}`);
      return "whatsapp";
    }

    console.warn("ALERT_NOT_DELIVERED", safeJson(body));
    return "log-only";
  }

  async function attemptRecovery(target, failure) {
    if (!failure.recoverable || !target.recoveryUrl) return { attempted: false, reason: "not-approved-or-not-recoverable" };
    const incident = state.incidents[target.id] || {};
    const last = incident.lastRecoveryAt ? Date.parse(incident.lastRecoveryAt) : 0;
    if (Date.now() - last < config.recoveryCooldownMs) return { attempted: false, reason: "cooldown" };

    incident.lastRecoveryAt = new Date().toISOString();
    state.incidents[target.id] = incident;
    const response = await fetch(target.recoveryUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.RECOVERY_TOKEN ? { Authorization: `Bearer ${process.env.RECOVERY_TOKEN}` } : {}),
      },
      body: safeJson({ targetId: target.id, evidence: failure }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) throw new Error(`Approved recovery hook returned HTTP ${response.status}`);
    return { attempted: true, reason: "approved-transient-recovery" };
  }

  async function checkTarget(target) {
    const checkedAt = new Date().toISOString();
    const started = Date.now();
    let result;
    try {
      const response = await fetch(target.url, { signal: AbortSignal.timeout(config.timeoutMs) });
      let body = null;
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) body = await response.json();
      const latencyMs = Date.now() - started;
      const whatsappFailure = target.expectWhatsappReady && body?.whatsappReady !== true;
      const latencyFailure = target.maxLatencyMs && latencyMs > target.maxLatencyMs;
      if (!response.ok || whatsappFailure || latencyFailure) {
        const message = whatsappFailure
          ? "WhatsApp session not ready"
          : latencyFailure
            ? `Response time ${latencyMs}ms exceeded ${target.maxLatencyMs}ms`
            : `HTTP ${response.status}`;
        const classification = latencyFailure
          ? { kind: "efficiency", recoverable: false }
          : classifyFailure({ status: response.status, message });
        result = { ok: false, status: response.status, message, classification, body, latencyMs, checkedAt };
      } else {
        result = { ok: true, status: response.status, body, latencyMs: Date.now() - started, checkedAt };
      }
    } catch (error) {
      const classification = classifyFailure({ message: error.message });
      result = { ok: false, status: null, message: error.message, classification, latencyMs: Date.now() - started, checkedAt };
    }

    const previous = state.targets[target.id] || { consecutiveFailures: 0, incidentOpen: false };
    if (result.ok) {
      const wasOpen = previous.incidentOpen;
      state.targets[target.id] = { ...result, consecutiveFailures: 0, incidentOpen: false };
      if (wasOpen) {
        await sendAlert({
          severity: "resolved",
          targetId: target.id,
          message: `RESOLVED: ${target.name} is healthy again. Verified HTTP ${result.status} in ${result.latencyMs}ms.`,
        });
      }
      return state.targets[target.id];
    }

    const failures = (previous.consecutiveFailures || 0) + 1;
    const incidentOpen = previous.incidentOpen || failures >= config.failureThreshold;
    state.targets[target.id] = { ...result, consecutiveFailures: failures, incidentOpen };

    if (!previous.incidentOpen && incidentOpen) {
      let recovery = { attempted: false, reason: "not-evaluated" };
      try { recovery = await attemptRecovery(target, result.classification); }
      catch (error) { recovery = { attempted: true, reason: "recovery-failed", error: error.message }; }
      await sendAlert({
        severity: result.classification.kind === "authentication" ? "critical" : "error",
        targetId: target.id,
        classification: result.classification.kind,
        recovery,
        message: `ALERT: ${target.name} failed ${failures} consecutive checks. ${result.message}. Classification: ${result.classification.kind}. Recovery: ${recovery.reason}.`,
      });
    }
    return state.targets[target.id];
  }

  let running = false;
  async function runChecks() {
    if (running) return { skipped: true, reason: "check-already-running" };
    running = true;
    try {
      const results = [];
      for (const target of config.targets) results.push(await checkTarget(target));

      if (state.lastMakeHeartbeatAt) {
        const age = Date.now() - Date.parse(state.lastMakeHeartbeatAt);
        const existing = state.incidents.makeHeartbeat || {};
        if (age > config.makeHeartbeatMaxAgeMs && !existing.open) {
          state.incidents.makeHeartbeat = { open: true, openedAt: new Date().toISOString() };
          await sendAlert({
            severity: "critical",
            targetId: "make-heartbeat",
            message: `ALERT: Make watchdog heartbeat is ${Math.round(age / 60000)} minutes old. Make may be stopped or unable to reach Railway. No automatic patch attempted.`,
          });
        } else if (age <= config.makeHeartbeatMaxAgeMs && existing.open) {
          state.incidents.makeHeartbeat = { open: false, resolvedAt: new Date().toISOString() };
          await sendAlert({ severity: "resolved", targetId: "make-heartbeat", message: "RESOLVED: Make watchdog heartbeat has resumed." });
        }
      }

      state.lastCheckAt = new Date().toISOString();
      persistState();
      return { skipped: false, results };
    } finally {
      running = false;
    }
  }

  function requireAdmin(req, res, next) {
    if (!config.adminToken) return res.status(503).json({ error: "ADMIN_TOKEN is not configured" });
    if (req.get("authorization") !== `Bearer ${config.adminToken}`) return res.status(401).json({ error: "Unauthorized" });
    next();
  }

  app.get("/health", (req, res) => {
    const failing = Object.values(state.targets).filter(item => item.incidentOpen).length;
    res.status(failing ? 503 : 200).json({ ok: failing === 0, service: "btsa-maintenance-agent", incidents: failing, lastCheckAt: state.lastCheckAt });
  });

  app.get("/status", requireAdmin, (req, res) => res.json({ ...state, config: {
    intervalMs: config.intervalMs,
    failureThreshold: config.failureThreshold,
    targets: config.targets.map(({ recoveryUrl, ...target }) => ({ ...target, recoveryConfigured: Boolean(recoveryUrl) })),
    alertConfigured: Boolean(config.alertWebhookUrl || (config.whatsappBridgeUrl && config.alertChatId)),
  }}));

  app.post("/events", async (req, res) => {
    if (!config.eventSecret) return res.status(503).json({ error: "EVENT_SECRET is not configured" });
    if (req.get("x-maintenance-secret") !== config.eventSecret) return res.status(401).json({ error: "Unauthorized" });
    const event = req.body || {};
    if (!event.type) return res.status(400).json({ error: "type is required" });
    if (event.type === "make-heartbeat") {
      state.lastMakeHeartbeatAt = new Date().toISOString();
    } else if (event.type === "scenario-failure") {
      const classification = classifyFailure({ status: event.status, message: event.error || event.message || "" });
      const eventKey = String(event.eventId || `${event.scenarioId || "unknown"}:${event.executionId || "unknown"}`);
      if (!state.incidents[eventKey]?.open) {
        state.incidents[eventKey] = { open: true, openedAt: new Date().toISOString(), classification: classification.kind };
        await sendAlert({
          severity: classification.kind === "authentication" ? "critical" : "error",
          targetId: String(event.scenarioId || "make-scenario"),
          classification: classification.kind,
          message: `ALERT: Make scenario ${event.scenarioName || event.scenarioId || "unknown"} failed. ${event.error || event.message || "No error text supplied"}. No automatic patch attempted.`,
        });
      }
    } else if (event.type === "scenario-recovered") {
      const eventKey = String(event.eventId || `${event.scenarioId || "unknown"}:${event.executionId || "unknown"}`);
      state.incidents[eventKey] = { open: false, resolvedAt: new Date().toISOString() };
      await sendAlert({
        severity: "resolved",
        targetId: String(event.scenarioId || "make-scenario"),
        message: `RESOLVED: Make scenario ${event.scenarioName || event.scenarioId || "unknown"} recovered and was verified.`,
      });
    }
    addEvent({ type: "inbound", event });
    persistState();
    res.status(202).json({ accepted: true });
  });

  app.post("/check", requireAdmin, async (req, res) => {
    try { res.json(await runChecks()); }
    catch (error) { res.status(500).json({ error: error.message }); }
  });

  restoreState();
  return { app, config, state, runChecks };
}

function start() {
  const agent = createAgent();
  const port = process.env.PORT || 4000;
  const server = agent.app.listen(port, () => console.log(`BTSA Maintenance Agent listening on ${port}`));
  const timer = setInterval(() => agent.runChecks().catch(error => console.error("Scheduled check failed:", error)), agent.config.intervalMs);
  timer.unref();
  agent.runChecks().catch(error => console.error("Initial check failed:", error));
  return { ...agent, server, timer };
}

if (require.main === module) start();

module.exports = { classifyFailure, createAgent, parseTargets, start };
