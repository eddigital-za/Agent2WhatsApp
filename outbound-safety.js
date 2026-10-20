"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function installOutboundSafety(client, { file = "/app/.wwebjs_auth/outbound-safety.json", clock = Date.now, perChat = 10, globalLimit = 100 } = {}) {
  const original = client.sendMessage.bind(client);
  let state = { paused: false, blocked: {}, sends: [] };
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  }
  client.sendMessage = async (chatId, message, options) => {
    const now = clock();
    if (process.env.BRIDGE_EMERGENCY_PAUSED === "true" || state.paused || state.blocked[chatId]) throw new Error("Outbound circuit is paused");
    state.sends = state.sends.filter(x => now - x.at < 600000);
    const hash = crypto.createHash("sha256").update(JSON.stringify([chatId, message])).digest("hex");
    if (state.sends.some(x => x.hash === hash)) throw new Error("Duplicate outbound suppressed");
    const recent = state.sends.filter(x => now - x.at < 60000);
    if (recent.length >= globalLimit) { state.paused = true; save(); throw new Error("Global outbound circuit tripped"); }
    if (recent.filter(x => x.chatId === chatId).length >= perChat) { state.blocked[chatId] = true; save(); throw new Error("Chat outbound circuit tripped"); }
    // Reserve BEFORE the side effect. Unknown delivery outcomes are never retried.
    state.sends.push({ at: now, chatId, hash });
    save();
    return original(chatId, message, options);
  };
  return {
    status: () => ({ paused: state.paused || process.env.BRIDGE_EMERGENCY_PAUSED === "true", blockedChats: Object.keys(state.blocked), reservations: state.sends.length }),
    pause: () => { state.paused = true; save(); },
  };
}
module.exports = { installOutboundSafety };
