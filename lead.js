const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));

const ALLOWED_ORIGINS = new Set([
  "https://biketransport.co.za",
  "https://www.biketransport.co.za",
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const TZ = "Africa/Johannesburg";
const REPORT_CHAT_ID = process.env.LEAD_REPORT_CHAT_ID || "120363413031194219@g.us";
const DB_PATH = "/app/.wwebjs_auth/btsa-leads.sqlite";
const SEND_LEDGER_PATH = "/app/.wwebjs_auth/btsa-send-ledger.json";

const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_row INTEGER UNIQUE,
  submitted_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  name TEXT,
  phone TEXT NOT NULL,
  pickup TEXT,
  dropoff TEXT,
  bike_type TEXT,
  bike_make TEXT,
  bike_model TEXT,
  urgency TEXT,
  estimated_price TEXT,
  manual_review INTEGER DEFAULT 0,
  first_touch_due_at TEXT,
  first_touch_sent_at TEXT,
  replied_at TEXT,
  followup_sent_at TEXT,
  duplicate_suppressed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_first_touch_due ON leads(first_touch_due_at);
CREATE INDEX IF NOT EXISTS idx_leads_followup ON leads(first_touch_sent_at, replied_at, followup_sent_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  lead_id INTEGER,
  phone TEXT,
  event_type TEXT NOT NULL,
  event_key TEXT UNIQUE,
  source TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE TABLE IF NOT EXISTS report_runs (
  report_date TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);
`);

function isoNow() { return new Date().toISOString(); }
function addMinutesIso(iso, mins) { return new Date(new Date(iso).getTime() + mins * 60000).toISOString(); }
function addHoursIso(iso, hours) { return addMinutesIso(iso, hours * 60); }
function normalizeZaPhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0027")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `27${digits.slice(1)}`;
  if (digits.length === 9) digits = `27${digits}`;
  return digits;
}
function localNineDigit(value) {
  const intl = normalizeZaPhone(value);
  return intl.startsWith("27") && intl.length === 11 ? intl.slice(2) : intl;
}
function parseLeadTimestamp(value) {
  const s = String(value || "").trim();
  if (!s) return isoNow();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return new Date(s.replace(" ", "T") + "+02:00").toISOString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? isoNow() : d.toISOString();
}
function formatLocalDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${o.year}-${o.month}-${o.day}`;
}
function formatLocalTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
function localDateBounds(dateString) {
  const start = new Date(`${dateString}T00:00:00+02:00`);
  const end = new Date(start.getTime() + 86400000);
  return [start.toISOString(), end.toISOString()];
}
function previousLocalDate() {
  const today = formatLocalDate();
  return formatLocalDate(new Date(new Date(`${today}T00:00:00+02:00`).getTime() - 86400000));
}
function logEvent({ leadId = null, phone = null, type, key = null, source = "railway", details = null }) {
  try {
    db.prepare(`INSERT OR IGNORE INTO events(created_at,lead_id,phone,event_type,event_key,source,details) VALUES(?,?,?,?,?,?,?)`)
      .run(isoNow(), leadId, phone, type, key, source, details ? JSON.stringify(details) : null);
  } catch (e) { console.error("Event log error:", e.message); }
}

function readSendLedger() {
  try { return JSON.parse(fs.readFileSync(SEND_LEDGER_PATH, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") console.error("Send ledger read error:", e.message); return {}; }
}
function recordAcceptedSend(idempotencyKey, record) {
  if (!idempotencyKey) return;
  const ledger = readSendLedger();
  ledger[idempotencyKey] = { ...record, acceptedAt: isoNow() };
  const cutoff = Date.now() - 45 * 86400000;
  for (const [k, v] of Object.entries(ledger)) if (Date.parse(v.acceptedAt || 0) < cutoff) delete ledger[k];
  const tmp = `${SEND_LEDGER_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger), "utf8");
  fs.renameSync(tmp, SEND_LEDGER_PATH);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "/app/.wwebjs_auth" }),
  puppeteer: { headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium", args: ["--no-sandbox", "--disable-setuid-sandbox"] },
});
let latestQr = null;
let lastInboundAt = null;

async function sendWhatsApp({ phone, chatId, text, idempotencyKey }) {
  if (!text) throw new Error("Text is required");
  if (!client.info) throw new Error("WhatsApp session not ready");
  let targetChatId = chatId;
  if (!targetChatId && phone) targetChatId = `${normalizeZaPhone(phone)}@c.us`;
  if (!targetChatId) throw new Error("Valid phone or chatId required");
  const prior = idempotencyKey ? readSendLedger()[idempotencyKey] : null;
  if (prior) return { success: true, accepted: true, deduplicated: true, messageId: prior.messageId || null, chatId: prior.chatId || targetChatId };
  const result = await client.sendMessage(targetChatId, text);
  const messageId = result?.id?._serialized || null;
  recordAcceptedSend(idempotencyKey, { messageId, chatId: targetChatId });
  return { success: true, accepted: true, deduplicated: false, messageId, chatId: targetChatId };
}

app.get("/health", (req, res) => {
  let dbOk = false;
  try { db.prepare("SELECT 1").get(); dbOk = true; } catch (_) {}
  res.json({ ok: true, whatsappReady: Boolean(client.info), databaseReady: dbOk, lastInboundAt });
});
app.get("/qr", (req, res) => {
  if (!latestQr) return res.send("<html><body style='font-family:Arial;text-align:center;padding:40px'><h2>Waiting for WhatsApp QR...</h2><p>If already linked, the session may simply be starting.</p></body></html>");
  res.send(`<!DOCTYPE html><html><head><title>WhatsApp QR</title><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head><body style="font-family:Arial;text-align:center;padding:40px"><h2>Link BTSA Lead Agent</h2><p>WhatsApp → Linked Devices → Link a Device</p><div id="qrcode"></div><script>new QRCode(document.getElementById("qrcode"),{text:${JSON.stringify(latestQr)},width:320,height:320});</script></body></html>`);
});
app.get("/monitor", (req, res) => {
  const today = formatLocalDate();
  const [start, end] = localDateBounds(today);
  const counts = db.prepare(`SELECT COUNT(*) submissions, COUNT(DISTINCT phone) unique_leads, SUM(first_touch_sent_at IS NOT NULL) first_touch_sent, SUM(replied_at IS NOT NULL) replied, SUM(followup_sent_at IS NOT NULL) followups_sent, SUM(duplicate_suppressed_at IS NOT NULL) duplicates_suppressed FROM leads WHERE submitted_at>=? AND submitted_at<?`).get(start, end);
  res.json({ date: today, ...counts, lastInboundAt });
});

app.post("/lead", async (req, res) => {
  try {
    const b = req.body || {};
    const phone = localNineDigit(b.phone);
    if (!/^\d{9}$/.test(phone)) return res.status(400).json({ error: "Valid SA phone required" });
    const submittedAt = parseLeadTimestamp(b.timestamp || b.submittedAt);
    const receivedAt = isoNow();
    const sheetRow = Number(b.rowNumber || b.sheetRow || 0) || null;
    if (sheetRow) {
      const existing = db.prepare("SELECT id FROM leads WHERE sheet_row=?").get(sheetRow);
      if (existing) return res.json({ success: true, accepted: true, deduplicated: true, leadId: existing.id });
    }
    const priorSent = db.prepare(`SELECT id, first_touch_sent_at FROM leads WHERE phone=? AND first_touch_sent_at IS NOT NULL AND first_touch_sent_at>=? ORDER BY first_touch_sent_at DESC LIMIT 1`).get(phone, addHoursIso(receivedAt, -24));
    const dueAt = addMinutesIso(receivedAt, 3);
    const result = db.prepare(`INSERT INTO leads(sheet_row,submitted_at,received_at,name,phone,pickup,dropoff,bike_type,bike_make,bike_model,urgency,estimated_price,manual_review,first_touch_due_at,duplicate_suppressed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sheetRow, submittedAt, receivedAt, b.name || "", phone, b.pickup || "", b.dropoff || "", b.motorcycleType || b.bikeType || "", b.bikeMake || "", b.bikeModel || "", b.urgency || "", String(b.estimatedPrice || b.price || ""), b.manualReview ? 1 : 0, dueAt, priorSent ? receivedAt : null);
    const leadId = Number(result.lastInsertRowid);
    logEvent({ leadId, phone, type: "lead_received", key: sheetRow ? `lead-${sheetRow}` : null, source: b.source || "railway", details: { sheetRow } });
    if (priorSent) logEvent({ leadId, phone, type: "duplicate_suppressed", key: `duplicate-${leadId}`, details: { priorLeadId: priorSent.id } });
    res.json({ success: true, accepted: true, leadId, duplicateSuppressed: Boolean(priorSent), firstTouchDueAt: priorSent ? null : dueAt });
  } catch (e) { console.error("Lead ingest error:", e); res.status(500).json({ error: e.message }); }
});

app.post("/send", async (req, res) => {
  try { res.json(await sendWhatsApp(req.body || {})); }
  catch (e) { console.error("Send error:", e.message); res.status(500).json({ error: e.message }); }
});

const IGNORED_MESSAGE_TYPES = new Set(["e2e_notification","notification_template","notification_template_v2","protocol","ciphertext","revoked"]);
async function resolveInboundPhone(message) {
  const sourceId = message.author || message.from || "";
  if (sourceId.endsWith("@lid")) {
    try { const m = await client.getContactLidAndPhone([sourceId]); const pn = m?.[0]?.pn || ""; if (pn) return pn.replace("@c.us", ""); } catch (_) {}
  }
  try { const c = await message.getContact(); if (c?.number) return c.number; } catch (_) {}
  if (sourceId.endsWith("@c.us")) return sourceId.replace("@c.us", "");
  return "";
}
const seenInbound = new Set();
async function handleInbound(message) {
  try {
    if (message.fromMe || message.from === "status@broadcast" || message.from.endsWith("@broadcast") || message.from.endsWith("@g.us") || IGNORED_MESSAGE_TYPES.has(message.type)) return;
    const messageId = message.id?._serialized || "";
    if (messageId && seenInbound.has(messageId)) return;
    if (messageId) { seenInbound.add(messageId); if (seenInbound.size > 5000) seenInbound.clear(); }
    const phone = localNineDigit(await resolveInboundPhone(message));
    if (!/^\d{9}$/.test(phone)) return console.error("Inbound skipped: invalid phone", message.from);
    lastInboundAt = isoNow();
    const lead = db.prepare("SELECT * FROM leads WHERE phone=? ORDER BY submitted_at DESC LIMIT 1").get(phone);
    if (lead) {
      if (!lead.replied_at) db.prepare("UPDATE leads SET replied_at=? WHERE id=?").run(lastInboundAt, lead.id);
      logEvent({ leadId: lead.id, phone, type: "reply_received", key: messageId || null, source: "whatsapp", details: { type: message.type } });
    } else {
      logEvent({ phone, type: "unmatched_reply", key: messageId || null, source: "whatsapp" });
    }
    console.log("Inbound reply recorded", { phone, leadId: lead?.id || null, messageId });
  } catch (e) { console.error("Inbound handler error:", e.message); }
}
client.on("message", handleInbound);
client.on("message_create", handleInbound);

async function processFirstTouches() {
  if (!client.info) return;
  const rows = db.prepare(`SELECT * FROM leads WHERE first_touch_sent_at IS NULL AND replied_at IS NULL AND duplicate_suppressed_at IS NULL AND manual_review=0 AND first_touch_due_at<=? ORDER BY first_touch_due_at ASC LIMIT 20`).all(isoNow());
  for (const lead of rows) {
    const key = `lead-first-touch-phone-${lead.phone}-${formatLocalDate(new Date(lead.submitted_at))}`;
    const text = `Hi ${lead.name || "there"}, thanks for reaching out to Bike Transport South Africa 🇿🇦\n\nI see you already got an estimate from our website 💪\n${[lead.bike_make, lead.bike_model].filter(Boolean).join(" ")}\nRoute: ${lead.pickup} → ${lead.dropoff}${lead.estimated_price ? ` with an estimate of R${lead.estimated_price}` : ""}${lead.urgency ? ` | ${lead.urgency}` : ""}\n\nHow soon do you need transport? Availability and routing change quickly, so this allows me to secure the best rate before slots fill.\n\nThanks, Duane`;
    try {
      const out = await sendWhatsApp({ phone: lead.phone, text, idempotencyKey: key });
      if (out.deduplicated) db.prepare("UPDATE leads SET duplicate_suppressed_at=? WHERE id=?").run(isoNow(), lead.id);
      else db.prepare("UPDATE leads SET first_touch_sent_at=? WHERE id=?").run(isoNow(), lead.id);
      logEvent({ leadId: lead.id, phone: lead.phone, type: out.deduplicated ? "first_touch_suppressed" : "first_touch_sent", key: `${key}-event-${lead.id}`, details: out });
    } catch (e) { logEvent({ leadId: lead.id, phone: lead.phone, type: "first_touch_failed", key: `first-touch-failed-${lead.id}-${Date.now()}`, details: { error: e.message } }); }
  }
}

async function processFollowups() {
  if (!client.info) return;
  const cutoff = addHoursIso(isoNow(), -24);
  const rows = db.prepare(`SELECT * FROM leads WHERE first_touch_sent_at IS NOT NULL AND first_touch_sent_at<=? AND replied_at IS NULL AND followup_sent_at IS NULL ORDER BY first_touch_sent_at ASC LIMIT 20`).all(cutoff);
  for (const lead of rows) {
    const key = `lead-24h-followup-${lead.id}`;
    const text = `Hi ${lead.name || "there"}, just checking in on your ${[lead.bike_make, lead.bike_model].filter(Boolean).join(" ")} transport from ${lead.pickup} to ${lead.dropoff}. If you still need it moved, let me know and I’ll check the current route availability and best rate for you.\n\nThanks, Duane`;
    try {
      const out = await sendWhatsApp({ phone: lead.phone, text, idempotencyKey: key });
      db.prepare("UPDATE leads SET followup_sent_at=? WHERE id=?").run(isoNow(), lead.id);
      logEvent({ leadId: lead.id, phone: lead.phone, type: "followup_sent", key: `${key}-event`, details: out });
    } catch (e) { logEvent({ leadId: lead.id, phone: lead.phone, type: "followup_failed", key: `followup-failed-${lead.id}-${Date.now()}`, details: { error: e.message } }); }
  }
}

async function maybeSendDailyReport() {
  if (!client.info || formatLocalTime() !== "06:00") return;
  const reportDate = previousLocalDate();
  if (db.prepare("SELECT 1 FROM report_runs WHERE report_date=?").get(reportDate)) return;
  const [start, end] = localDateBounds(reportDate);
  const m = db.prepare(`SELECT COUNT(*) submissions, COUNT(DISTINCT phone) unique_leads, SUM(first_touch_sent_at IS NOT NULL) first_touch_sent, SUM(replied_at IS NOT NULL) replied, SUM(duplicate_suppressed_at IS NOT NULL) duplicates_suppressed, SUM(manual_review=1) manual_review FROM leads WHERE submitted_at>=? AND submitted_at<?`).get(start, end);
  const followups = db.prepare(`SELECT COUNT(*) c FROM events WHERE event_type='followup_sent' AND created_at>=? AND created_at<?`).get(start, end).c;
  const replies = db.prepare(`SELECT COUNT(*) c FROM events WHERE event_type='reply_received' AND created_at>=? AND created_at<?`).get(start, end).c;
  const replyRate = m.unique_leads ? Math.round((m.replied / m.unique_leads) * 100) : 0;
  const text = `BTSA LEAD REPORT — ${reportDate}\n\nSubmissions: ${m.submissions || 0}\nUnique leads: ${m.unique_leads || 0}\nDuplicate/repeat submissions suppressed: ${m.duplicates_suppressed || 0}\nFirst-touch WhatsApps sent: ${m.first_touch_sent || 0}\nLeads replied: ${m.replied || 0}/${m.unique_leads || 0} (${replyRate}%)\nReplies received yesterday: ${replies || 0}\n24h follow-ups sent yesterday: ${followups || 0}\nManual-review enquiries: ${m.manual_review || 0}`;
  try {
    await sendWhatsApp({ chatId: REPORT_CHAT_ID, text, idempotencyKey: `lead-daily-report-${reportDate}` });
    db.prepare("INSERT INTO report_runs(report_date,sent_at) VALUES(?,?)").run(reportDate, isoNow());
    logEvent({ type: "daily_report_sent", key: `report-${reportDate}`, details: { reportDate } });
  } catch (e) { console.error("Daily report failed:", e.message); }
}

client.on("qr", qr => { latestQr = qr; console.log("New WhatsApp QR generated. Open /qr to scan it."); });
client.on("authenticated", () => { latestQr = null; console.log("WhatsApp authenticated."); });
client.on("loading_screen", (percent, message) => console.log("WhatsApp loading:", percent, message));
client.on("change_state", state => console.log("WhatsApp state:", state));
client.on("ready", () => console.log("BTSA Lead WhatsApp service is ready."));
client.on("auth_failure", message => console.error("Authentication failed:", message));
client.on("disconnected", reason => console.log("WhatsApp disconnected:", reason));

function removeChromiumLocks(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) removeChromiumLocks(full);
    else if (["SingletonLock","SingletonSocket","SingletonCookie"].includes(entry.name)) { try { fs.unlinkSync(full); } catch (_) {} }
  }
}
removeChromiumLocks("/app/.wwebjs_auth");
client.initialize();
setInterval(() => { processFirstTouches().catch(console.error); }, 30000);
setInterval(() => { processFollowups().catch(console.error); }, 300000);
setInterval(() => { maybeSendDailyReport().catch(console.error); }, 60000);

const PORT = 4000;
app.listen(PORT, () => console.log(`BTSA Lead service listening on ${PORT}; SQLite ${DB_PATH}`));