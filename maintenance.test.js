"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyFailure, parseTargets } = require("./maintenance");
const http = require("node:http");

test("classifies deterministic data and mapping failures as non-recoverable", () => {
  for (const message of [
    "ValidationFault: Duplicate Name Exists Error",
    "Unable to parse range Aundefined:ZZundefined",
    "The provided JSON body content is not valid JSON",
  ]) {
    assert.deepEqual(classifyFailure({ message }), { kind: "deterministic", recoverable: false });
  }
});

test("classifies authentication failures as non-recoverable", () => {
  assert.deepEqual(classifyFailure({ status: 503, message: "WhatsApp session not ready" }), {
    kind: "authentication",
    recoverable: false,
  });
});

test("classifies bounded infrastructure failures as transient", () => {
  assert.deepEqual(classifyFailure({ status: 502, message: "Bad gateway" }), { kind: "transient", recoverable: true });
  assert.deepEqual(classifyFailure({ message: "fetch failed: ECONNREFUSED" }), { kind: "transient", recoverable: true });
});

test("does not guess recovery for unknown failures", () => {
  assert.deepEqual(classifyFailure({ status: 418, message: "unexpected" }), { kind: "unknown", recoverable: false });
});

test("rejects invalid monitor configuration", () => {
  assert.throws(() => parseTargets("not-json"), /invalid JSON/);
  assert.throws(() => parseTargets("{}"), /must be an array/);
  assert.throws(() => parseTargets('[{"id":"x","name":"X","url":"http://example.com"}]'), /must use HTTPS/);
});

test("accepts an HTTPS health target", () => {
  const targets = parseTargets('[{"id":"x","name":"X","url":"https://example.com/health","expectWhatsappReady":true}]');
  assert.equal(targets.length, 1);
  assert.equal(targets[0].expectWhatsappReady, true);
  assert.equal(targets[0].recoveryUrl, null);
});

test("opens an incident only after the configured consecutive failure threshold", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ ok: false }), {
    status: 502,
    headers: { "content-type": "application/json" },
  });
  try {
    const agent = require("./maintenance").createAgent({
      targets: [{ id: "service", name: "Service", url: "https://service.test/health", expectWhatsappReady: false, recoveryUrl: null }],
      failureThreshold: 2,
      timeoutMs: 1000,
    });
    await agent.runChecks();
    assert.equal(agent.state.targets.service.incidentOpen, false);
    await agent.runChecks();
    assert.equal(agent.state.targets.service.incidentOpen, true);
    assert.equal(agent.state.targets.service.classification.kind, "transient");
  } finally {
    global.fetch = originalFetch;
  }
});

test("never invokes a recovery hook for an authentication failure", async () => {
  const originalFetch = global.fetch;
  let recoveryCalls = 0;
  global.fetch = async url => {
    if (String(url).includes("recovery.test")) {
      recoveryCalls += 1;
      return new Response("ok", { status: 200 });
    }
    return new Response(JSON.stringify({ whatsappReady: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const agent = require("./maintenance").createAgent({
      targets: [{ id: "wa", name: "WhatsApp", url: "https://wa.test/health", expectWhatsappReady: true, recoveryUrl: "https://recovery.test/run" }],
      failureThreshold: 1,
      timeoutMs: 1000,
    });
    await agent.runChecks();
    assert.equal(agent.state.targets.wa.classification.kind, "authentication");
    assert.equal(recoveryCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("deduplicates repeated Make failure events", async () => {
  const agent = require("./maintenance").createAgent({ eventSecret: "secret", targets: [] });
  const server = http.createServer(agent.app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const send = () => fetch(`http://127.0.0.1:${address.port}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-maintenance-secret": "secret" },
      body: JSON.stringify({ type: "scenario-failure", eventId: "same-run", scenarioName: "Invoice Agent", error: "Duplicate Name Exists" }),
    });
    assert.equal((await send()).status, 202);
    assert.equal((await send()).status, 202);
    assert.equal(agent.state.events.filter(event => event.type === "alert").length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
