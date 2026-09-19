const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { DatabaseSync } = require('node:sqlite');

const app = express();
app.use(express.json({ limit: '2mb' }));

const TZ = 'Africa/Johannesburg';
const AUTH_DIR = '/app/.wwebjs_auth';
const DB_PATH = path.join(AUTH_DIR, 'btsa-scheduling.sqlite');
const GROUP_ID = process.env.ORDERS_GROUP_ID || '';
const API_KEY = process.env.INTAKE_API_KEY || '';
const CALENDAR_WEBHOOK_URL = process.env.CALENDAR_WEBHOOK_URL || '';
const CALENDAR_WEBHOOK_SECRET = process.env.CALENDAR_WEBHOOK_SECRET || '';
const SHADOW_MODE = String(process.env.SHADOW_MODE || 'true').toLowerCase() === 'true';
const MORNING_HOUR = Number(process.env.MORNING_SUMMARY_HOUR || 7);
const EVENING_HOUR = Number(process.env.EVENING_SUMMARY_HOUR || 17);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT UNIQUE NOT NULL,
  client_name TEXT,
  route TEXT,
  bike TEXT,
  contractor TEXT,
  transport_method TEXT,
  collection_at TEXT,
  collection_confidence TEXT DEFAULT 'unknown',
  delivery_at TEXT,
  delivery_confidence TEXT DEFAULT 'unknown',
  status TEXT DEFAULT 'unscheduled',
  next_action TEXT,
  next_action_at TEXT,
  calendar_collection_id TEXT,
  calendar_delivery_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_next_action ON orders(next_action_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  order_id INTEGER,
  event_type TEXT NOT NULL,
  event_key TEXT UNIQUE,
  details TEXT
);
CREATE TABLE IF NOT EXISTS question_links (
  message_id TEXT PRIMARY KEY,
  order_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS report_runs (
  run_key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contractors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE COLLATE NOCASE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

const SHEET_CONTRACTORS = [
  'UBT',
  'Cheetah Express',
  'Bike Transport',
  'Armand',
  'Bike in Motion',
  'DJ Bike Transport',
  'Ross - Speedway Express',
  'BTSA',
  'Boat Express',
  'George',
  'Assets in Motion',
  'Moto Movers'
];
const seedContractor = db.prepare(`
  INSERT INTO contractors(name,active,created_at,updated_at) VALUES(?,1,?,?)
  ON CONFLICT(name) DO UPDATE SET active=1,updated_at=excluded.updated_at
`);
for (const name of SHEET_CONTRACTORS) seedContractor.run(name, new Date().toISOString(), new Date().toISOString());

function nowIso() { return new Date().toISOString(); }
function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}
function localDate(date = new Date()) { const p = localParts(date); return `${p.year}-${p.month}-${p.day}`; }
function localHour(date = new Date()) { return Number(localParts(date).hour); }
function localMinute(date = new Date()) { return Number(localParts(date).minute); }
function atLocal(dateString, hour = 8, minute = 0) { return new Date(`${dateString}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+02:00`); }
function addDays(date, days) { return new Date(date.getTime() + days * 86400000); }
function fmt(dateValue) {
  if (!dateValue) return 'Not scheduled';
  return new Intl.DateTimeFormat('en-ZA', { timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(dateValue));
}
function event(orderId, type, key, details = null) {
  db.prepare('INSERT OR IGNORE INTO events(created_at,order_id,event_type,event_key,details) VALUES(?,?,?,?,?)')
    .run(nowIso(), orderId, type, key || null, details ? JSON.stringify(details) : null);
}
function auth(req, res, next) {
  if (!API_KEY) return res.status(503).json({ error: 'INTAKE_API_KEY is not configured' });
  const supplied = String(req.get('x-api-key') || '');
  const a = Buffer.from(supplied); const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_DIR, clientId: 'btsa-scheduling' }),
  puppeteer: { headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox','--disable-setuid-sandbox'] }
});
let latestQr = null;
let lastInboundAt = null;

async function sendGroup(text, key, orderId = null) {
  if (!GROUP_ID) throw new Error('ORDERS_GROUP_ID is not configured');
  if (key && db.prepare('SELECT 1 FROM events WHERE event_key=?').get(key)) return { deduplicated: true };
  if (SHADOW_MODE) {
    event(orderId, 'shadow_message', key, { text });
    console.log('[SHADOW]', text);
    return { shadow: true };
  }
  if (!client.info) throw new Error('WhatsApp session is not ready');
  const result = await client.sendMessage(GROUP_ID, text);
  const messageId = result?.id?._serialized || null;
  event(orderId, 'message_sent', key, { text, messageId });
  if (messageId && orderId) db.prepare('INSERT OR REPLACE INTO question_links(message_id,order_id,created_at) VALUES(?,?,?)').run(messageId,orderId,nowIso());
  return { messageId };
}

function orderLabel(o) { return `${o.external_id}${o.client_name ? ` | ${o.client_name}` : ''}${o.route ? ` | ${o.route}` : ''}`; }
function fieldFromBlock(text, heading, field) {
  const block = String(text || '').match(new RegExp(`\\*?${heading} DETAILS\\*?([\\s\\S]*?)(?=\\n\\*?[A-Z ]+ DETAILS\\*?|$)`, 'i'))?.[1] || '';
  return block.match(new RegExp(`^${field}:\\s*(.+)$`, 'im'))?.[1]?.trim() || '';
}
function parseNewOrderMessage(text, messageId) {
  const body = String(text || '');
  const header = body.match(/^\*?New Order\s*-\s*(.+?)\s*-\s*R?([\d.,]+)\*?\s*$/im);
  if (!header) return null;
  const collectionName = fieldFromBlock(body, 'COLLECTION', 'Contact');
  const deliveryName = fieldFromBlock(body, 'DELIVERY', 'Contact');
  const bike = body.match(/^Make and Model:\s*(.+)$/im)?.[1]?.trim() || '';
  const stableSource = messageId || body;
  const suffix = crypto.createHash('sha256').update(stableSource).digest('hex').slice(0, 10).toUpperCase();
  return {
    externalId: `WA-${suffix}`,
    clientName: deliveryName || collectionName,
    route: header[1].trim(),
    bike,
    source: 'orders-whatsapp-group'
  };
}
async function ingestGroupOrder(text, messageId) {
  const parsed = parseNewOrderMessage(text, messageId);
  if (!parsed) return null;
  const existing = db.prepare('SELECT * FROM orders WHERE external_id=?').get(parsed.externalId);
  if (existing) return { order: existing, deduplicated: true };
  const now = nowIso();
  const result = db.prepare('INSERT INTO orders(external_id,client_name,route,bike,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(parsed.externalId, parsed.clientName, parsed.route, parsed.bike, 'unscheduled', now, now);
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(result.lastInsertRowid));
  event(order.id, 'order_received', `order-${parsed.externalId}`, { source: parsed.source, messageId });
  await askForMissing(order);
  return { order, deduplicated: false };
}
function missingQuestion(o) {
  const missing = [];
  if (!o.collection_at) missing.push('collection date');
  if (!o.delivery_at) missing.push('delivery date');
  if (!o.contractor && !o.transport_method) missing.push('BTSA/subcontractor assignment');
  return `*Scheduling information needed: ${o.external_id}*\n${[o.client_name,o.bike,o.route].filter(Boolean).join(' | ')}\nMissing: ${missing.join(', ')}.\nReply to this message with the schedule update.`;
}
async function askForMissing(o) {
  if (o.collection_at && o.delivery_at && (o.contractor || o.transport_method)) return;
  const key = `missing-info-${o.id}-${localDate()}`;
  const out = await sendGroup(missingQuestion(o), key, o.id);
  if (out.messageId) db.prepare('INSERT OR REPLACE INTO question_links(message_id,order_id,created_at) VALUES(?,?,?)').run(out.messageId, o.id, nowIso());
}

function nextWeekday(base, weekday, forceNextWeek) {
  const p = localDate(base);
  const local = atLocal(p, 9, 0);
  let delta = (weekday - local.getUTCDay() + 7) % 7;
  if (forceNextWeek || delta === 0) delta += 7;
  return addDays(local, delta);
}
function parseDate(text) {
  const t = String(text || '').toLowerCase();
  const today = atLocal(localDate(), 9, 0);
  let date = null;
  if (/\btoday\b/.test(t)) date = today;
  else if (/\bthis afternoon\b/.test(t)) date = atLocal(localDate(), 15, 0);
  else if (/\btomorrow\b/.test(t)) date = addDays(today, 1);
  else {
    const iso = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    const za = t.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](20\d{2}))?\b/);
    if (iso) date = atLocal(`${iso[1]}-${iso[2]}-${iso[3]}`, 9, 0);
    else if (za) date = atLocal(`${za[3] || localParts().year}-${String(za[2]).padStart(2,'0')}-${String(za[1]).padStart(2,'0')}`, 9, 0);
    else {
      const weekdays = { sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6 };
      for (const [name, day] of Object.entries(weekdays)) if (new RegExp(`\\b${name}\\b`).test(t)) { date = nextWeekday(new Date(), day, /\bnext\s+/.test(t)); break; }
    }
  }
  if (!date) return null;
  const tm = t.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);
  if (tm) date = atLocal(localDate(date), Number(tm[1]), Number(tm[2]));
  return date;
}
function confidence(text) { return /\b(probably|maybe|expected|likely|should|provisional|tentative)\b/i.test(text) ? 'expected' : 'confirmed'; }
function normalizedContractor(value) {
  const input = String(value || '').toLowerCase();
  if (input.includes('cheeta express')) return 'Cheetah Express';
  return db.prepare('SELECT name FROM contractors WHERE active=1 ORDER BY length(name) DESC').all()
    .find(row => {
      const name = String(row.name).toLowerCase();
      const variants = [name];
      if (name.includes(' - ')) variants.push(name.split(' - ').pop());
      return variants.some(candidate => input.includes(candidate));
    })?.name || null;
}
function orderKey(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function findOrderFromText(text) {
  const ids = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const lower = String(text || '').toLowerCase();
  const compact = orderKey(text);
  const mentioned = String(text || '').match(/\bSL(?:A)?[\s-]?(\d+)\b/i);
  const mentionedKey = mentioned ? `SLA${mentioned[1]}` : null;
  const exact = mentionedKey ? ids.filter(o => orderKey(o.external_id) === mentionedKey) : ids.filter(o => compact.includes(orderKey(o.external_id)));
  if (exact.length === 1) return exact[0];
  const name = ids.filter(o => !o.completed_at && o.client_name && lower.includes(String(o.client_name).toLowerCase()));
  return name.length === 1 ? name[0] : null;
}
function splitOrderUpdates(text) {
  const body = String(text || '');
  const matches = [...body.matchAll(/\bSL(?:A)?[\s-]?(\d+)\b/gi)];
  if (matches.length <= 1) return [body];
  return matches.map((match,index) => body.slice(match.index, matches[index + 1]?.index || body.length).trim()).filter(Boolean);
}
function responseText(payload) {
  if (payload?.output_text) return payload.output_text;
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) if (content?.type === 'output_text' && content.text) return content.text;
  }
  return '';
}
async function interpretSchedulingMessage(text, quotedText = '', forcedExternalId = '') {
  if (!OPENAI_API_KEY) return null;
  const orders = db.prepare("SELECT external_id,client_name,route,bike,contractor,transport_method,collection_at,delivery_at,status,completed_at FROM orders ORDER BY completed_at IS NOT NULL,created_at DESC LIMIT 60").all();
  const contractors = db.prepare('SELECT name FROM contractors WHERE active=1 ORDER BY name COLLATE NOCASE').all().map(row=>row.name);
  const now = new Date();
  const prompt = [
    `Current timestamp: ${now.toISOString()}. Business timezone: ${TZ}. Local date: ${localDate(now)}.`,
    `Known orders: ${JSON.stringify(orders)}`,
    `Known contractors: ${JSON.stringify(contractors)}`,
    `Quoted WhatsApp message, if any: ${JSON.stringify(String(quotedText || ''))}`,
    `Order fixed by the quoted-message database link, if any: ${JSON.stringify(String(forcedExternalId || ''))}`,
    `WhatsApp message: ${JSON.stringify(String(text || ''))}`
  ].join('\n');
  const schema = {
    type:'object', additionalProperties:false,
    properties:{
      updates:{type:'array',items:{
        type:'object',additionalProperties:false,
        properties:{
          external_id:{type:'string'},
          action:{type:'string',enum:['update','clarify']},
          collection_at:{type:['string','null']},
          delivery_at:{type:['string','null']},
          collection_confidence:{type:'string',enum:['unknown','expected','confirmed']},
          delivery_confidence:{type:'string',enum:['unknown','expected','confirmed']},
          contractor:{type:['string','null']},
          transport_method:{type:'string',enum:['unchanged','BTSA','subcontractor']},
          status:{type:'string',enum:['unchanged','unscheduled','scheduled','in_transit','completed','cancelled']},
          clarification:{type:'string'},
          summary:{type:'string'}
        },
        required:['external_id','action','collection_at','delivery_at','collection_confidence','delivery_confidence','contractor','transport_method','status','clarification','summary']
      }}
    },required:['updates']
  };
  const response = await fetch('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{'authorization':`Bearer ${OPENAI_API_KEY}`,'content-type':'application/json'},
    body:JSON.stringify({
      model:OPENAI_MODEL,
      input:[
        {role:'system',content:`You interpret informal South African WhatsApp scheduling updates for a motorcycle transport business. Messages often come from speech-to-text and may contain missing punctuation, wrong capitals, minor spelling errors, shortened SLA references, and multiple orders. Match an order only when the number or customer/context identifies exactly one known order. Treat SLA381, SLA 381, SL381, 381 and spoken variants as possible SLA-381. A quoted-message database link fixes the order and must be used. Otherwise quoted reminder text may identify the order. A generic message such as delivered, collected, done or cancelled with no explicit order and no quoted context is ambiguous: never guess from recency; return clarify with an empty external_id. Correct obvious contractor spelling against the supplied list, including shortened company names. Resolve relative dates in ${TZ} and return local wall-clock ISO values; 11:30 means 11:30 in ${TZ}, never 11:30 UTC. Do not invent a date, time, contractor, status, or order. Null means unchanged. If a material instruction is ambiguous, use action clarify and state one short question. Return one item per intended order.`},
        {role:'user',content:prompt}
      ],
      text:{format:{type:'json_schema',name:'btsa_scheduling_updates',strict:true,schema}}
    })
  });
  if (!response.ok) throw new Error(`OpenAI interpreter HTTP ${response.status}: ${await response.text()}`);
  const raw = responseText(await response.json());
  if (!raw) throw new Error('OpenAI interpreter returned no structured text');
  return JSON.parse(raw);
}
function validIso(value) {
  if (!value) return null;
  const local = String(value).match(/^(20\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (local) return atLocal(`${local[1]}-${local[2]}-${local[3]}`,Number(local[4]),Number(local[5])).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
async function applyInterpretedUpdate(plan, messageKey) {
  const order = db.prepare('SELECT * FROM orders WHERE external_id=? COLLATE NOCASE').get(String(plan.external_id || '').trim());
  if (!order || plan.action === 'clarify') {
    const question = plan.clarification || `Which order does this update refer to: ${plan.summary || 'the message received'}?`;
    await sendGroup(question,`ai-clarify-${messageKey}-${order?.id || 'unknown'}`,order?.id || null);
    return {clarified:true};
  }
  const fields=[]; const values=[];
  const collectionAt=validIso(plan.collection_at); const deliveryAt=validIso(plan.delivery_at);
  if(collectionAt){fields.push('collection_at=?','collection_confidence=?');values.push(collectionAt,plan.collection_confidence);}
  if(deliveryAt){fields.push('delivery_at=?','delivery_confidence=?');values.push(deliveryAt,plan.delivery_confidence);}
  if(plan.contractor){
    const contractor=normalizedContractor(plan.contractor);
    if(contractor){fields.push('contractor=?','transport_method=?');values.push(contractor,/^btsa$/i.test(contractor)?'BTSA':'subcontractor');}
  } else if(plan.transport_method!=='unchanged') { fields.push('transport_method=?'); values.push(plan.transport_method); }
  if(plan.status!=='unchanged'){
    fields.push('status=?'); values.push(plan.status);
    if(['completed','cancelled'].includes(plan.status)){fields.push('completed_at=?');values.push(nowIso());}
    else {fields.push('completed_at=NULL');}
  } else if(collectionAt||deliveryAt){fields.push('status=?');values.push('scheduled');}
  if(!fields.length){
    await sendGroup(plan.clarification || `I understood ${orderLabel(order)}, but no scheduling change was clear. What should I update?`,`ai-empty-${messageKey}-${order.id}`,order.id);
    return {clarified:true};
  }
  fields.push('updated_at=?'); values.push(nowIso(),order.id);
  db.prepare(`UPDATE orders SET ${fields.join(',')} WHERE id=?`).run(...values);
  const updated=db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  recalc(updated); await syncCalendar(updated);
  await sendGroup(`*${updated.external_id} updated*\n${plan.summary}\nCollection: ${fmt(updated.collection_at)} (${updated.collection_confidence})\nDelivery: ${fmt(updated.delivery_at)} (${updated.delivery_confidence})\nAssigned: ${updated.contractor||updated.transport_method||'Not assigned'}\nStatus: ${String(updated.status).replaceAll('_',' ')}`,`ai-update-${messageKey}-${updated.id}`,updated.id);
  return {updated:true,orderId:updated.id};
}
async function syncCalendar(o) {
  if (!CALENDAR_WEBHOOK_URL) return;
  const payload = JSON.stringify({ action:'upsert', order:o, timezone:TZ });
  const signature = CALENDAR_WEBHOOK_SECRET ? crypto.createHmac('sha256', CALENDAR_WEBHOOK_SECRET).update(payload).digest('hex') : '';
  const response = await fetch(CALENDAR_WEBHOOK_URL, { method:'POST', headers:{'content-type':'application/json','x-btsa-signature':signature}, body:payload });
  if (!response.ok) throw new Error(`Calendar webhook HTTP ${response.status}`);
}
function recalc(o) {
  const now = new Date();
  const candidates = [];
  for (const [kind, value] of [['collection',o.collection_at],['delivery',o.delivery_at]]) {
    if (!value) continue;
    const when = new Date(value);
    candidates.push({ at:addDays(when,-2), action:`${kind}_two_day` });
    candidates.push({ at:addDays(when,-1), action:`${kind}_one_day` });
    candidates.push({ at:when, action:`${kind}_due` });
  }
  const next = candidates.filter(x=>x.at>now).sort((a,b)=>a.at-b.at)[0];
  db.prepare('UPDATE orders SET next_action=?,next_action_at=?,updated_at=? WHERE id=?').run(next?.action || null,next?.at.toISOString() || null,nowIso(),o.id);
}
async function applyUpdate(o, text) {
  const date = parseDate(text);
  const lower = text.toLowerCase();
  let changed = false;
  if (/\b(cancel|cancelled)\b/.test(lower)) { db.prepare("UPDATE orders SET status='cancelled',completed_at=?,updated_at=? WHERE id=?").run(nowIso(),nowIso(),o.id); changed=true; }
  else if (/\b(completed|complete|delivered)\b/.test(lower) && !date) { db.prepare("UPDATE orders SET status='completed',completed_at=?,updated_at=? WHERE id=?").run(nowIso(),nowIso(),o.id); changed=true; }
  else if (date) {
    const conf = confidence(text);
    if (/\bdeliver/.test(lower)) db.prepare("UPDATE orders SET delivery_at=?,delivery_confidence=?,status='scheduled',updated_at=? WHERE id=?").run(date.toISOString(),conf,nowIso(),o.id);
    else db.prepare("UPDATE orders SET collection_at=?,collection_confidence=?,status='scheduled',updated_at=? WHERE id=?").run(date.toISOString(),conf,nowIso(),o.id);
    changed=true;
  }
  const contractor = normalizedContractor(text);
  if (contractor) {
    db.prepare('UPDATE orders SET contractor=?,transport_method=?,updated_at=? WHERE id=?').run(contractor,/^btsa$/i.test(contractor)?'BTSA':'subcontractor',nowIso(),o.id);
    changed=true;
  }
  if (/\bin[ -]?transit\b/i.test(text)) {
    db.prepare("UPDATE orders SET status='in_transit',updated_at=? WHERE id=?").run(nowIso(),o.id);
    changed=true;
  }
  if (!changed) return false;
  const updated = db.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
  recalc(updated);
  await syncCalendar(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id));
  await sendGroup(`*${updated.external_id} updated*\nCollection: ${fmt(updated.collection_at)} (${updated.collection_confidence})\nDelivery: ${fmt(updated.delivery_at)} (${updated.delivery_confidence})\nAssigned: ${updated.contractor || updated.transport_method || 'Not assigned'}\nStatus: ${String(updated.status).replaceAll('_',' ')}`, `update-confirm-${updated.id}-${Date.now()}`, updated.id);
  return true;
}

const seen = new Set();
async function inbound(message) {
  try {
    if (message.fromMe || message.from !== GROUP_ID || !message.body) return;
    const mid = message.id?._serialized || '';
    if (mid && seen.has(mid)) return;
    if (mid) { seen.add(mid); if (seen.size>5000) seen.clear(); }
    lastInboundAt = nowIso();
    const ingested = await ingestGroupOrder(message.body, mid);
    if (ingested) {
      event(ingested.order.id, 'inbound_processed', mid, { text: message.body, newOrder: true, deduplicated: ingested.deduplicated });
      return;
    }
    let quotedText=''; let quotedOrder=null;
    if(message.hasQuotedMsg){
      const quoted=await message.getQuotedMessage();
      quotedText=quoted?.body||'';
      const qid=quoted?.id?._serialized||'';
      const link=qid?db.prepare('SELECT order_id FROM question_links WHERE message_id=?').get(qid):null;
      if(link)quotedOrder=db.prepare('SELECT * FROM orders WHERE id=?').get(link.order_id);
    }
    if(!quotedText && /^\s*(delivered|complete|completed|collected|done|cancelled|canceled|in transit)\s*[.!]?\s*$/i.test(message.body)){
      await sendGroup('Which SLA number is this update for?',`clarify-generic-${mid}`);
      event(null,'inbound_clarification',mid,{text:message.body,reason:'missing_order'});
      return;
    }
    if (OPENAI_API_KEY) {
      try {
        const interpreted = await interpretSchedulingMessage(message.body,quotedText,quotedOrder?.external_id||'');
        if (interpreted?.updates?.length) {
          for (let index=0; index<interpreted.updates.length; index++) await applyInterpretedUpdate(interpreted.updates[index],`${mid}-${index}`);
          event(null,'ai_inbound_processed',mid,{text:message.body,updates:interpreted.updates.length});
          return;
        }
      } catch (error) {
        console.error('AI interpreter failed; using local parser:',error.message);
      }
    }
    const updates = splitOrderUpdates(message.body);
    if (updates.length > 1) {
      for (let index=0; index<updates.length; index++) {
        const update = updates[index];
        const order = findOrderFromText(update);
        if (!order) {
          await sendGroup(`I could not identify the order in this update: ${update}`, `clarify-${mid}-${index}`);
          continue;
        }
        const applied = await applyUpdate(order, update);
        if (!applied) await sendGroup(`I found ${orderLabel(order)}, but I could not safely identify the update.`, `clarify-${mid}-${index}`, order.id);
        event(order.id,'inbound_processed',`${mid}-${index}`,{text:update,multiOrder:true});
      }
      return;
    }
    let order = findOrderFromText(message.body) || quotedOrder;
    if (!order) return;
    const applied = await applyUpdate(order, message.body);
    if (!applied) await sendGroup(`I found ${orderLabel(order)}, but I could not safely identify a collection/delivery date or completion instruction. Please include collection or delivery and the date.`, `clarify-${mid}`, order.id);
    event(order.id,'inbound_processed',mid,{text:message.body});
  } catch (e) { console.error('Inbound scheduling error:',e.message); }
}

app.get('/health',(req,res)=>{ let databaseReady=false; try{db.prepare('SELECT 1').get();databaseReady=true;}catch(_){} res.json({ok:true,whatsappReady:Boolean(client.info),databaseReady,shadowMode:SHADOW_MODE,lastInboundAt}); });
app.get('/qr',(req,res)=>{ if(!latestQr)return res.send('<h2>Waiting for WhatsApp QR or already connected</h2>'); res.send(`<!doctype html><title>BTSA Scheduling QR</title><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><h2>Link BTSA Scheduling Agent</h2><div id="q"></div><script>new QRCode(document.getElementById('q'),{text:${JSON.stringify(latestQr)},width:320,height:320});</script>`); });
app.get('/orders',auth,(req,res)=>res.json(db.prepare('SELECT * FROM orders ORDER BY completed_at IS NOT NULL, COALESCE(collection_at,delivery_at,created_at)').all()));
app.get('/contractors',auth,(req,res)=>res.json(db.prepare('SELECT name,active,created_at,updated_at FROM contractors ORDER BY name COLLATE NOCASE').all()));
app.post('/contractors',auth,(req,res)=>{
  const name=String(req.body?.name||'').trim();
  if(!name)return res.status(400).json({error:'name is required'});
  const now=nowIso();
  db.prepare(`INSERT INTO contractors(name,active,created_at,updated_at) VALUES(?,1,?,?) ON CONFLICT(name) DO UPDATE SET active=1,updated_at=excluded.updated_at`).run(name,now,now);
  res.json({success:true,contractor:db.prepare('SELECT name,active,created_at,updated_at FROM contractors WHERE name=? COLLATE NOCASE').get(name)});
});
app.post('/order',auth,async(req,res)=>{
  try{
    const b=req.body||{}; const externalId=String(b.externalId||b.entryId||b.orderId||'').trim();
    if(!externalId)return res.status(400).json({error:'externalId is required'});
    const existing=db.prepare('SELECT * FROM orders WHERE external_id=?').get(externalId);
    if(existing)return res.json({success:true,deduplicated:true,order:existing});
    const now=nowIso();
    const r=db.prepare('INSERT INTO orders(external_id,client_name,route,bike,contractor,transport_method,collection_at,delivery_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(externalId,b.clientName||b.name||'',b.route||'',b.bike||[b.make,b.model].filter(Boolean).join(' '),b.contractor||'',b.transportMethod||'',b.collectionAt||null,b.deliveryAt||null,(b.collectionAt||b.deliveryAt)?'scheduled':'unscheduled',now,now);
    const o=db.prepare('SELECT * FROM orders WHERE id=?').get(Number(r.lastInsertRowid));
    recalc(o); event(o.id,'order_received',`order-${externalId}`,{source:b.source||'webhook'}); await syncCalendar(o); await askForMissing(o);
    res.json({success:true,deduplicated:false,order:db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)});
  }catch(e){console.error('Order intake error:',e);res.status(500).json({error:e.message});}
});
app.post('/send',auth,async(req,res)=>{try{res.json(await sendGroup(req.body.text,req.body.idempotencyKey||`manual-${Date.now()}`));}catch(e){res.status(500).json({error:e.message});}});

async function dueReminders(){
  const rows=db.prepare("SELECT * FROM orders WHERE completed_at IS NULL AND status NOT IN ('cancelled','completed') AND next_action_at IS NOT NULL AND next_action_at<=? ORDER BY next_action_at LIMIT 20").all(nowIso());
  for(const o of rows){
    const action=o.next_action; const kind=action.startsWith('collection')?'Collection':'Delivery';
    const when=kind==='Collection'?o.collection_at:o.delivery_at;
    await sendGroup(`*${kind} reminder: ${o.external_id}*\n${[o.client_name,o.bike,o.route].filter(Boolean).join(' | ')}\nScheduled: ${fmt(when)}\nAssigned: ${o.contractor||o.transport_method||'Not assigned'}\nReply with an update if this has changed.`, `reminder-${o.id}-${action}`,o.id);
    db.prepare('UPDATE orders SET next_action_at=NULL,next_action=NULL,updated_at=? WHERE id=?').run(nowIso(),o.id);
    recalc(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id));
  }
}
async function summary(period){
  const key=`${period}-summary-${localDate()}`; if(db.prepare('SELECT 1 FROM report_runs WHERE run_key=?').get(key))return;
  const open=db.prepare("SELECT * FROM orders WHERE completed_at IS NULL AND status NOT IN ('cancelled','completed') ORDER BY COALESCE(collection_at,delivery_at,created_at)").all();
  const lines=open.slice(0,30).map(o=>`• ${o.external_id}: C ${fmt(o.collection_at)} | D ${fmt(o.delivery_at)} | ${o.contractor||o.transport_method||'unassigned'}`);
  await sendGroup(`*BTSA scheduling ${period} summary*\nOpen orders: ${open.length}\n${lines.join('\n')||'No open orders.'}`,key);
  db.prepare('INSERT OR IGNORE INTO report_runs(run_key,sent_at) VALUES(?,?)').run(key,nowIso());
}
setInterval(()=>dueReminders().catch(console.error),60000);
setInterval(()=>{
  if(localMinute()!==0)return;
  if(localHour()===MORNING_HOUR)summary('morning').catch(console.error);
  if(localHour()===EVENING_HOUR)summary('evening').catch(console.error);
},60000);

client.on('message',inbound);
client.on('qr',qr=>{latestQr=qr;console.log('Scheduling WhatsApp QR generated');});
client.on('authenticated',()=>{latestQr=null;console.log('Scheduling WhatsApp authenticated');});
client.on('ready',()=>console.log('BTSA Scheduling Agent ready'));
client.on('auth_failure',m=>console.error('WhatsApp auth failure:',m));
client.on('disconnected',r=>console.error('WhatsApp disconnected:',r));

function removeLocks(dir){if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())removeLocks(f);else if(['SingletonLock','SingletonSocket','SingletonCookie'].includes(e.name)){try{fs.unlinkSync(f);}catch(_){}}}}
removeLocks(AUTH_DIR); client.initialize();
async function interpreterSelfTest(){
  const key='interpreter-self-test-v2';
  if(!OPENAI_API_KEY||db.prepare('SELECT 1 FROM report_runs WHERE run_key=?').get(key))return;
  const sample=`SLA381 in transit delivery will be today BTSA doing the delivery\nSL382 in transit with Cheetah Express delivery will be today at approximately 11:30\nSLA385 Cheeta Express delivered an hour ago\nSLA386 in transit with Speedway express shared revenue trip delivery expected this afternoon`;
  const result=await interpretSchedulingMessage(sample);
  const ids=(result?.updates||[]).map(update=>orderKey(update.external_id));
  const expected=['SLA381','SLA382','SLA385','SLA386'];
  if(expected.some(id=>!ids.includes(id)))throw new Error(`Interpreter self-test order mismatch: ${ids.join(',')}`);
  const short=await interpretSchedulingMessage('381 delivered');
  if(orderKey(short?.updates?.[0]?.external_id)!=='SLA381'||short?.updates?.[0]?.status!=='completed')throw new Error('Interpreter self-test failed for short numeric update');
  const quoted=await interpretSchedulingMessage('Delivered','Delivery reminder: SLA-381 | Alan Boyd | Honda XR650L','SLA-381');
  if(orderKey(quoted?.updates?.[0]?.external_id)!=='SLA381'||quoted?.updates?.[0]?.status!=='completed')throw new Error('Interpreter self-test failed for quoted update');
  db.prepare('INSERT OR IGNORE INTO report_runs(run_key,sent_at) VALUES(?,?)').run(key,nowIso());
  console.log(`AI scheduling interpreter verified: multi-order=${result.updates.length}, short-form=true, quoted-reply=true`);
}
const PORT=Number(process.env.PORT||4000); app.listen(PORT,()=>{
  console.log(`BTSA Scheduling Agent listening on ${PORT}; SQLite ${DB_PATH}; shadow=${SHADOW_MODE}; ai=${Boolean(OPENAI_API_KEY)}`);
  interpreterSelfTest().catch(error=>console.error('AI interpreter self-test failed:',error.message));
});
