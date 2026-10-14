"use strict";
const crypto = require("node:crypto");

function parseRoutes(raw) {
  if (!raw) return Object.freeze({});
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WHATSAPP_GROUP_ROUTES must be an object");
  for (const [group, route] of Object.entries(value)) {
    if (!/^\d+@g\.us$/.test(group)) throw new Error("Invalid route group ID");
    if (!route || typeof route !== "object" || typeof route.url !== "string") throw new Error("Invalid route destination");
    const url = new URL(route.url);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Routes require HTTPS without URL credentials");
    if (route.secretEnv && !/^[A-Z][A-Z0-9_]*$/.test(route.secretEnv)) throw new Error("Invalid route secret variable");
    Object.freeze(route);
  }
  return Object.freeze(value);
}

async function forwardRoute(route, payload, env = process.env, fetchFn = fetch) {
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (route.secretEnv) {
    const secret = env[route.secretEnv];
    if (!secret) throw new Error("Route signing secret is missing");
    headers["x-btsa-signature"] = crypto.createHmac("sha256", secret).update(body).digest("hex");
  }
  // Never automatically retry a request with an uncertain downstream outcome.
  const response = await fetchFn(route.url, {
    method: "POST", headers, body, redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("Group route HTTP " + response.status);
}
module.exports = { parseRoutes, forwardRoute };
