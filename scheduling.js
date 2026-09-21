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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SOCIAL_PROOF_WEBHOOK_URL = process.env.SOCIAL_PROOF_WEBHOOK_URL || '';
const AGENT_HANDOFF_SECRET = process.env.AGENT_HANDOFF_SECRET || '';

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
const PROOF_DIR = path.join(AUTH_DIR, 'proofs');
if (!fs.existsSync(PROOF_DIR)) fs.mkdirSync(PROOF_DIR, { recursive: true });
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
CREATE TABLE IF NOT EXISTS proofs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  stage TEXT NOT NULL,
  whatsapp_message_id TEXT UNIQUE NOT NULL,
  mime_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  vision_json TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE TABLE IF NOT EXISTS proof_links (
  message_id TEXT PRIMARY KEY,
  proof_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
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

function orderLabel(o) { return `${o.external_id}${o.bike ? ` | ${o.bike}` : ''}${o.client_name ? ` | ${o.client_name}` : ''}${o.route ? ` | ${o.route}` : ''}`; }
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
  return `❓ *${o.external_id} | ${o.bike||'Motorcycle'}*\nNeed: ${missing.join(', ')}\nReply with the update.`;
}
function compactOrderUpdate(o, heading='Updated') {
  return `✅ *${o.external_id} | ${o.bike||'Motorcycle'}*\n${heading}\nC: ${fmt(o.collection_at)}\nD: ${fmt(o.delivery_at)}\nVia: ${o.contractor||o.transport_method||'Unassigned'}\nStatus: ${String(o.status).replaceAll('_',' ')}`;
}
async function askForMissing(o) {
  if (o.collection_at && o.delivery_at && (o.contractor || o.transport_method)) return;
  const key = `missing-info-${o.id}-${localDate()}`;
  const out = await sendGroup(missingQuestion(o), key, o.id);
  if (out.messageId) db.prepare('INSERT OR REPLACE INTO question_links(message_id,order_id,created_at) VALUES(?,?,?)').run(out.messageId, o.id, nowIso());
}

function nextWeekday(base, weekday) {
  const p = localDate(base);
  const local = atLocal(p, 9, 0);
  let delta = (weekday - local.getUTCDay() + 7) % 7;
  if (delta === 0) delta = 7;
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
    const named = t.match(/\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
    if (iso) date = atLocal(`${iso[1]}-${iso[2]}-${iso[3]}`, 9, 0);
    else if (za) date = atLocal(`${za[3] || localParts().year}-${String(za[2]).padStart(2,'0')}-${String(za[1]).padStart(2,'0')}`, 9, 0);
    else if (named) {
      const months={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
      let year=Number(localParts().year);
      date=atLocal(`${year}-${String(months[named[2]]).padStart(2,'0')}-${String(named[1]).padStart(2,'0')}`,9,0);
      if(date<addDays(today,-1))date=atLocal(`${year+1}-${String(months[named[2]]).padStart(2,'0')}-${String(named[1]).padStart(2,'0')}`,9,0);
    }
    else {
      const weekdays = { sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6 };
      for (const [name, day] of Object.entries(weekdays)) if (new RegExp(`\\b${name}\\b`).test(t)) { date = nextWeekday(new Date(), day); break; }
    }
  }
  if (!date) return null;
  const tm = t.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);
  if (tm) date = atLocal(localDate(date), Number(tm[1]), Number(tm[2]));
  else if(/\bafternoon\b/.test(t))date=atLocal(localDate(date),15,0);
  else if(/\bmorning\b/.test(t))date=atLocal(localDate(date),9,0);
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
function linkedRowForQuotedIds(table,selectColumn,quotedIds) {
  for(const id of quotedIds.filter(Boolean)){
    const row=db.prepare(`SELECT ${selectColumn} FROM ${table} WHERE message_id=? OR message_id LIKE ? ORDER BY message_id=? DESC LIMIT 1`).get(id,`%${id}`,id);
    if(row)return row;
  }
  return null;
}
async function quotedContext(message) {
  let text=message?._data?.quotedMsg?.body||message?._data?.quotedMsg?.caption||message?._data?.quotedMsg?.content||'';
  const ids=[];
  const raw=message?._data?.quotedStanzaID||message?._data?.quotedMsg?.id?._serialized||message?._data?.quotedMsg?.id?.id||'';
  if(raw)ids.push(String(raw));
  if(message.hasQuotedMsg){
    try{
      const quoted=await message.getQuotedMessage();
      text=quoted?.body||'';
      const serialized=quoted?.id?._serialized||quoted?.id?.id||'';
      if(serialized)ids.unshift(String(serialized));
    }catch(error){
      console.warn('WhatsApp quoted-message fetch failed; using stored quoted ID:',error?.message||String(error));
    }
  }
  return {text,ids:[...new Set(ids)]};
}
function sourceSegmentForOrder(text,externalId){
  return splitOrderUpdates(text).find(segment=>orderKey(segment).includes(orderKey(externalId)))||String(text||'');
}
function stageClause(text,stage){
  const other=stage==='collection'?'delivery':'collection';
  return String(text||'').match(new RegExp(`\\b${stage}\\b([\\s\\S]*?)(?=\\b${other}\\b|\\bSL(?:A)?[\\s-]?\\d+\\b|$)`,'i'))?.[0]||'';
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
function proofStage(text) {
  if (/\b(deliver(?:ed|y)?|drop[ -]?off)\b/i.test(text)) return 'delivery';
  if (/\b(collect(?:ed|ion)?|pick[ -]?up)\b/i.test(text)) return 'collection';
  return null;
}
function extensionForMime(mime) {
  return ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/heic':'heic'}[mime] || 'bin');
}
async function downloadMediaFromEventData(message) {
  const data=message?._data||{};
  const args={
    directPath:data.directPath,
    encFilehash:data.encFilehash,
    filehash:data.filehash,
    mediaKey:data.mediaKey,
    mediaKeyTimestamp:data.mediaKeyTimestamp,
    type:data.type||message.type,
    mimetype:data.mimetype,
    filename:data.filename||null
  };
  if(!args.directPath||!args.mediaKey)throw new Error('WhatsApp media metadata incomplete');
  return client.pupPage.evaluate(async mediaArgs=>{
    const managerModule=window.require('WAWebDownloadManager');
    const manager=managerModule.downloadManager||managerModule;
    const mockQpl={addAnnotations(){return this;},addPoint(){return this;}};
    const decrypted=await manager.downloadAndMaybeDecrypt({
      directPath:mediaArgs.directPath,
      encFilehash:mediaArgs.encFilehash,
      filehash:mediaArgs.filehash,
      mediaKey:mediaArgs.mediaKey,
      mediaKeyTimestamp:mediaArgs.mediaKeyTimestamp,
      type:mediaArgs.type,
      signal:new AbortController().signal,
      downloadQpl:mockQpl
    });
    return {
      data:await window.WWebJS.arrayBufferToBase64Async(decrypted),
      mimetype:mediaArgs.mimetype||'application/octet-stream',
      filename:mediaArgs.filename||null
    };
  },args);
}
async function getInboundMedia(message) {
  try{
    const media=await message.downloadMedia();
    if(media?.data)return media;
    throw new Error('downloadMedia returned no data');
  }catch(primaryError){
    console.warn('Standard media download failed; using event-data fallback:',primaryError?.message||String(primaryError));
    const media=await downloadMediaFromEventData(message);
    if(!media?.data)throw new Error('WhatsApp media fallback returned no data');
    console.log('Event-data media fallback succeeded');
    return media;
  }
}
async function analyzeProofPhoto(media, caption, stage) {
  const candidates=db.prepare("SELECT external_id,client_name,route,bike,contractor,collection_at,delivery_at,status FROM orders WHERE status NOT IN ('cancelled') ORDER BY completed_at IS NOT NULL,updated_at DESC LIMIT 40").all();
  const schema={type:'object',additionalProperties:false,properties:{
    external_id:{type:['string','null']},confidence:{type:'number'},bike_description:{type:'string'},reason:{type:'string'},
    contains_face:{type:'boolean'},contains_number_plate:{type:'boolean'},contains_address_or_document:{type:'boolean'},social_safety_note:{type:'string'}
  },required:['external_id','confidence','bike_description','reason','contains_face','contains_number_plate','contains_address_or_document','social_safety_note']};
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:`Bearer ${OPENAI_API_KEY}`,'content-type':'application/json'},body:JSON.stringify({
    model:OPENAI_MODEL,
    input:[{role:'system',content:'Match a motorcycle proof photo against the supplied scheduling candidates. Use visible make/model/type/colour only and operational timing/context. Never identify a person. Select an external_id only when one candidate is materially stronger; otherwise return null. Inspect for faces, number plates, addresses and documents that should be reviewed before social publishing.'},{role:'user',content:[
      {type:'input_text',text:`Stage: ${stage}. Caption: ${caption}. Candidates: ${JSON.stringify(candidates)}`},
      {type:'input_image',image_url:`data:${media.mimetype};base64,${media.data}`,detail:'low'}
    ]}],text:{format:{type:'json_schema',name:'btsa_proof_match',strict:true,schema}}
  })});
  if(!response.ok)throw new Error(`OpenAI vision HTTP ${response.status}: ${await response.text()}`);
  return JSON.parse(responseText(await response.json()));
}
function enqueueSocialProof(proof,order,mediaData,vision,eventId=`proof-${proof.id}`){
  if(!SOCIAL_PROOF_WEBHOOK_URL||!AGENT_HANDOFF_SECRET)return;
  const payload={eventId,eventType:'delivery_proof_received',occurredAt:nowIso(),proof:{stage:proof.stage,mimeType:proof.mime_type,filename:proof.filename,mediaData},order:{externalId:order.external_id,bike:order.bike||'',route:order.route||'',clientName:order.client_name||'',contractor:order.contractor||order.transport_method||''},privacy:{containsFace:Boolean(vision?.contains_face),containsNumberPlate:Boolean(vision?.contains_number_plate),containsAddressOrDocument:Boolean(vision?.contains_address_or_document),note:vision?.social_safety_note||''}};
  db.prepare("INSERT OR IGNORE INTO outbox(event_key,event_type,payload,status,attempts,next_attempt_at,created_at) VALUES(?,?,?,'pending',0,?,?)").run(payload.eventId,payload.eventType,JSON.stringify(payload),nowIso(),nowIso());
}
async function confirmProof(proofId,orderId){
  const proof=db.prepare('SELECT * FROM proofs WHERE id=?').get(proofId);
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if(!proof||!order)throw new Error('Proof or order not found');
  if(proof.status==='confirmed')return;
  const when=proof.created_at||nowIso();
  if(proof.stage==='delivery')db.prepare("UPDATE orders SET delivery_at=?,delivery_confidence='confirmed',status='completed',completed_at=?,updated_at=? WHERE id=?").run(when,when,when,order.id);
  else db.prepare("UPDATE orders SET collection_at=?,collection_confidence='confirmed',status='in_transit',updated_at=? WHERE id=?").run(when,when,order.id);
  db.prepare("UPDATE proofs SET order_id=?,status='confirmed',confirmed_at=? WHERE id=?").run(order.id,when,proof.id);
  const updated=db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  recalc(updated);
  const vision=proof.vision_json?JSON.parse(proof.vision_json):{};
  if(proof.stage==='delivery')enqueueSocialProof(proof,updated,fs.readFileSync(proof.file_path).toString('base64'),vision);
  await sendGroup(`✅ *${proof.stage==='delivery'?'Delivered':'Collected'} | ${updated.external_id}*\n${updated.bike||'Motorcycle'}\n${fmt(when)}`,`proof-confirmed-${proof.id}`,updated.id);
}
async function handleProofPhoto(message,quotedOrder){
  const stage=proofStage(message.body||'');
  const media=await getInboundMedia(message);
  if(!media?.data)throw new Error('WhatsApp returned no image data');
  if(!String(media.mimetype||'').startsWith('image/')){await sendGroup('Please send a photo for collection or delivery proof.',`proof-image-${message.id?._serialized||Date.now()}`);return true;}
  const mid=message.id?._serialized||crypto.randomUUID();
  const filename=`proof-${Date.now()}-${crypto.createHash('sha256').update(mid).digest('hex').slice(0,10)}.${extensionForMime(media.mimetype)}`;
  const filePath=path.join(PROOF_DIR,filename);
  fs.writeFileSync(filePath,Buffer.from(media.data,'base64'));
  let order=findOrderFromText(message.body)||quotedOrder||null;
  if(!stage){
    db.prepare('INSERT OR IGNORE INTO proofs(order_id,stage,whatsapp_message_id,mime_type,filename,file_path,vision_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(order?.id||null,'unknown',mid,media.mimetype,filename,filePath,'{}','awaiting_stage',nowIso());
    const proof=db.prepare('SELECT * FROM proofs WHERE whatsapp_message_id=?').get(mid);
    const out=await sendGroup('Is this a collection or delivery photo? Reply with Collection or Delivery. Add the SLA number if you know it.',`proof-stage-${proof.id}`,order?.id||null);
    if(out.messageId)db.prepare('INSERT OR REPLACE INTO proof_links(message_id,proof_id,created_at) VALUES(?,?,?)').run(out.messageId,proof.id,nowIso());
    return true;
  }
  let vision={};
  if(!order&&OPENAI_API_KEY)vision=await analyzeProofPhoto(media,message.body||'',stage);
  if(!order&&vision.external_id)order=db.prepare('SELECT * FROM orders WHERE external_id=? COLLATE NOCASE').get(vision.external_id);
  const status=order&&(findOrderFromText(message.body)||quotedOrder)?'ready':'awaiting_confirmation';
  const result=db.prepare('INSERT OR IGNORE INTO proofs(order_id,stage,whatsapp_message_id,mime_type,filename,file_path,vision_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(order?.id||null,stage,mid,media.mimetype,filename,filePath,JSON.stringify(vision),status,nowIso());
  const proof=db.prepare('SELECT * FROM proofs WHERE whatsapp_message_id=?').get(mid);
  if(proof.status==='confirmed')return true;
  if(status==='ready'){await confirmProof(proof.id,order.id);return true;}
  if(order&&Number(vision.confidence)>=0.65){
    const out=await sendGroup(`I think this is *${orderLabel(order)}*. Confirm ${stage}? Reply YES, or reply with the correct SLA number.`, `proof-match-${proof.id}`,order.id);
    if(out.messageId)db.prepare('INSERT OR REPLACE INTO proof_links(message_id,proof_id,created_at) VALUES(?,?,?)').run(out.messageId,proof.id,nowIso());
  }else{
    const out=await sendGroup(`I could not safely match this ${stage} photo. Reply to this message with the SLA number.`, `proof-unmatched-${proof.id}`);
    if(out.messageId)db.prepare('INSERT OR REPLACE INTO proof_links(message_id,proof_id,created_at) VALUES(?,?,?)').run(out.messageId,proof.id,nowIso());
  }
  return true;
}
async function processOutbox(){
  if(!SOCIAL_PROOF_WEBHOOK_URL||!AGENT_HANDOFF_SECRET)return;
  const rows=db.prepare("SELECT * FROM outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY id LIMIT 5").all(nowIso());
  for(const row of rows){
    const body=row.payload; const signature=crypto.createHmac('sha256',AGENT_HANDOFF_SECRET).update(body).digest('hex');
    try{
      const response=await fetch(SOCIAL_PROOF_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json','x-btsa-signature':signature},body});
      if(!response.ok)throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      db.prepare("UPDATE outbox SET status='delivered',delivered_at=?,attempts=attempts+1,last_error=NULL WHERE id=?").run(nowIso(),row.id);
    }catch(error){
      const attempts=row.attempts+1; const delay=Math.min(3600,Math.pow(2,attempts)*30);
      db.prepare("UPDATE outbox SET attempts=?,next_attempt_at=?,last_error=? WHERE id=?").run(attempts,new Date(Date.now()+delay*1000).toISOString(),String(error.message).slice(0,500),row.id);
    }
  }
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
        {role:'system',content:`You interpret informal South African WhatsApp scheduling updates for a motorcycle transport business. Messages often come from speech-to-text and may contain missing punctuation, wrong capitals, minor spelling errors, shortened SLA references, and multiple orders. Match an order only when the number or customer/context identifies exactly one known order. Treat SLA381, SLA 381, SL381, 381 and spoken variants as possible SLA-381. A quoted-message database link fixes the order and must be used. Otherwise quoted reminder text may identify the order. A generic message such as delivered, collected, done or cancelled with no explicit order and no quoted context is ambiguous: never guess from recency; return clarify with an empty external_id. Correct obvious contractor spelling against the supplied list, including shortened company names. Resolve relative dates in ${TZ} and return local wall-clock ISO values; 11:30 means 11:30 in ${TZ}, never 11:30 UTC. Always return the explicitly requested status, even when the known order already has that status: delivered means completed, cancelled means cancelled, and in transit means in_transit. Do not invent a date, time, contractor, status, or order. Null means unchanged. If a material instruction is ambiguous, use action clarify and state one short question. Return one item per intended order.`},
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
async function applyInterpretedUpdate(plan, messageKey, sourceText='') {
  const order = db.prepare('SELECT * FROM orders WHERE external_id=? COLLATE NOCASE').get(String(plan.external_id || '').trim());
  if (!order || plan.action === 'clarify') {
    const question = plan.clarification || `Which order does this update refer to: ${plan.summary || 'the message received'}?`;
    await sendGroup(question,`ai-clarify-${messageKey}-${order?.id || 'unknown'}`,order?.id || null);
    return {clarified:true};
  }
  const fields=[]; const values=[];
  const segment=sourceSegmentForOrder(sourceText,plan.external_id);
  const collectionClause=stageClause(segment,'collection'); const deliveryClause=stageClause(segment,'delivery');
  const parsedCollection=parseDate(collectionClause); const parsedDelivery=parseDate(deliveryClause);
  const collectionAt=parsedCollection?.toISOString()||validIso(plan.collection_at); const deliveryAt=parsedDelivery?.toISOString()||validIso(plan.delivery_at);
  if(parsedCollection&&/\bweek of\b/i.test(collectionClause))plan.collection_confidence='expected';
  else if(parsedCollection)plan.collection_confidence=confidence(collectionClause);
  if(parsedDelivery)plan.delivery_confidence=confidence(deliveryClause);
  if(collectionAt){fields.push('collection_at=?','collection_confidence=?');values.push(collectionAt,plan.collection_confidence);}
  if(deliveryAt){fields.push('delivery_at=?','delivery_confidence=?');values.push(deliveryAt,plan.delivery_confidence);}
  if(plan.contractor){
    const contractor=normalizedContractor(plan.contractor);
    if(contractor){fields.push('contractor=?','transport_method=?');values.push(contractor,/^btsa$/i.test(contractor)?'BTSA':'subcontractor');}
  } else if(plan.transport_method!=='unchanged') { fields.push('transport_method=?'); values.push(plan.transport_method); }
  const effectiveStatus=(collectionAt||deliveryAt)&&['unchanged','unscheduled'].includes(plan.status)?'scheduled':plan.status;
  if(effectiveStatus!=='unchanged'){
    fields.push('status=?'); values.push(effectiveStatus);
    if(['completed','cancelled'].includes(effectiveStatus)){fields.push('completed_at=?');values.push(nowIso());}
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
  await sendGroup(compactOrderUpdate(updated,plan.summary||'Updated'),`ai-update-${messageKey}-${updated.id}`,updated.id);
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
  await sendGroup(compactOrderUpdate(updated), `update-confirm-${updated.id}-${Date.now()}`, updated.id);
  return true;
}

const seen = new Set();
function isOtherDepartmentMessage(text) {
  return /\b(invoice|invoiced|quickbooks|payment|paid|statement|receipt)\b/i.test(String(text||''));
}
async function inbound(message) {
  try {
    if (message.fromMe || message.from !== GROUP_ID || (!message.body&&!message.hasMedia)) return;
    const mid = message.id?._serialized || '';
    if (mid && seen.has(mid)) return;
    if (mid) { seen.add(mid); if (seen.size>5000) seen.clear(); }
    lastInboundAt = nowIso();
    const ingested = message.body ? await ingestGroupOrder(message.body, mid) : null;
    if (ingested) {
      event(ingested.order.id, 'inbound_processed', mid, { text: message.body, newOrder: true, deduplicated: ingested.deduplicated });
      return;
    }
    if(isOtherDepartmentMessage(message.body)){
      event(null,'inbound_ignored',mid,{text:message.body,reason:'other_department'});
      return;
    }
    const quote=await quotedContext(message);
    const quotedText=quote.text;
    const questionLink=linkedRowForQuotedIds('question_links','order_id',quote.ids);
    const quotedOrder=questionLink?db.prepare('SELECT * FROM orders WHERE id=?').get(questionLink.order_id):null;
    if(message.hasMedia){await handleProofPhoto(message,quotedOrder);return;}
    let proofLink=linkedRowForQuotedIds('proof_links','proof_id',quote.ids);
    if(!proofLink&&proofStage(message.body||'')){
      const cutoff=new Date(Date.now()-30*60*1000).toISOString();
      proofLink=db.prepare("SELECT id AS proof_id FROM proofs WHERE status='awaiting_stage' AND created_at>=? ORDER BY id DESC LIMIT 1").get(cutoff);
    }
    if(proofLink){
      const proof=db.prepare('SELECT * FROM proofs WHERE id=?').get(proofLink.proof_id);
      if(proof?.status==='awaiting_stage'){
        const stage=proofStage(message.body||'');
        const order=findOrderFromText(message.body)||quotedOrder||(proof.order_id?db.prepare('SELECT * FROM orders WHERE id=?').get(proof.order_id):null);
        if(!stage){await sendGroup('Please reply with Collection or Delivery. Add the SLA number if you know it.',`proof-stage-retry-${proof.id}`);return;}
        db.prepare("UPDATE proofs SET stage=?,order_id=?,status=? WHERE id=?").run(stage,order?.id||null,order?'ready':'awaiting_confirmation',proof.id);
        if(order){await confirmProof(proof.id,order.id);return;}
        const out=await sendGroup(`I have the ${stage} photo. Which SLA number is it for?`,`proof-order-${proof.id}`);
        if(out.messageId)db.prepare('INSERT OR REPLACE INTO proof_links(message_id,proof_id,created_at) VALUES(?,?,?)').run(out.messageId,proof.id,nowIso());
        return;
      }
      let order=/^\s*(yes|y|confirm|correct|yep|yeah)\s*[.!]?\s*$/i.test(message.body||'')&&proof?.order_id?db.prepare('SELECT * FROM orders WHERE id=?').get(proof.order_id):findOrderFromText(message.body);
      if(order){await confirmProof(proof.id,order.id);return;}
      await sendGroup('Reply with YES to confirm my suggested match, or send the correct SLA number.',`proof-retry-${mid}`);
      return;
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
          for (let index=0; index<interpreted.updates.length; index++) await applyInterpretedUpdate(interpreted.updates[index],`${mid}-${index}`,message.body);
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
  } catch (e) {
    const detail=e?.message||String(e);
    console.error('Inbound scheduling error:',detail,e?.stack||'');
    if(message.hasMedia){
      try{await sendGroup('I received the photo but could not process it. Please resend it once.',`proof-error-${message.id?._serialized||Date.now()}`);}catch(replyError){console.error('Failed to send proof error reply:',replyError?.message||String(replyError));}
    }
  }
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
    await sendGroup(`⏰ *${kind} | ${o.external_id}*\n${o.bike||'Motorcycle'}\n${fmt(when)}\nVia: ${o.contractor||o.transport_method||'Unassigned'}`, `reminder-${o.id}-${action}`,o.id);
    db.prepare('UPDATE orders SET next_action_at=NULL,next_action=NULL,updated_at=? WHERE id=?').run(nowIso(),o.id);
    recalc(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id));
  }
}
async function summary(period,requestedKey=''){
  const key=requestedKey||`${period}-summary-${localDate()}`; if(db.prepare('SELECT 1 FROM report_runs WHERE run_key=?').get(key))return;
  const open=db.prepare("SELECT * FROM orders WHERE completed_at IS NULL AND status NOT IN ('cancelled','completed') ORDER BY COALESCE(collection_at,delivery_at,created_at)").all();
  const lines=open.slice(0,30).map(o=>`*${o.external_id} | ${o.bike||'Motorcycle'}*\nRoute: ${o.route||'Not recorded'}\nC: ${fmt(o.collection_at)}\nD: ${fmt(o.delivery_at)}\nVia: ${o.contractor||o.transport_method||'Unassigned'}`);
  await sendGroup(`📋 *${period[0].toUpperCase()+period.slice(1)} schedule | ${open.length} open*\n\n${lines.join('\n\n')||'No open orders.'}`,key);
  db.prepare('INSERT OR IGNORE INTO report_runs(run_key,sent_at) VALUES(?,?)').run(key,nowIso());
}
async function repairSept19Updates(){
  const key='repair-2026-09-19-1755-updates-v1';
  if(db.prepare('SELECT 1 FROM report_runs WHERE run_key=?').get(key))return;
  const corrections=[
    ['SLA-387',atLocal('2026-09-20',9,0).toISOString(),atLocal('2026-09-25',9,0).toISOString(),'confirmed','confirmed','Ross - Speedway Express','subcontractor','scheduled',null],
    ['SLA-390',atLocal('2026-09-21',9,0).toISOString(),atLocal('2026-09-21',15,0).toISOString(),'confirmed','confirmed','BTSA','BTSA','scheduled',null],
    ['SLA-391',atLocal('2026-10-09',9,0).toISOString(),null,'expected','unknown',null,null,'scheduled',null],
    ['SLA-386',null,atLocal('2026-09-19',15,0).toISOString(),'unknown','confirmed',null,null,'completed',atLocal('2026-09-19',15,0).toISOString()]
  ];
  for(const [externalId,collectionAt,deliveryAt,collectionConfidence,deliveryConfidence,contractor,transportMethod,status,completedAt] of corrections){
    const order=db.prepare('SELECT * FROM orders WHERE external_id=? COLLATE NOCASE').get(externalId);
    if(!order)continue;
    db.prepare(`UPDATE orders SET collection_at=?,delivery_at=?,collection_confidence=?,delivery_confidence=?,contractor=COALESCE(?,contractor),transport_method=COALESCE(?,transport_method),status=?,completed_at=?,updated_at=? WHERE id=?`)
      .run(collectionAt,deliveryAt,collectionConfidence,deliveryConfidence,contractor,transportMethod,status,completedAt,nowIso(),order.id);
    recalc(db.prepare('SELECT * FROM orders WHERE id=?').get(order.id));
  }
  db.prepare('INSERT OR IGNORE INTO report_runs(run_key,sent_at) VALUES(?,?)').run(key,nowIso());
  await sendGroup(`*Schedule corrections applied*\nSLA-387: Collection Sun 20 Sept morning; delivery Fri 25 Sept; Ross - Speedway Express.\nSLA-390: Collection Mon 21 Sept; delivery Monday afternoon; BTSA.\nSLA-391: Collection expected for the week of 9 October.\nSLA-386: Delivered Saturday afternoon; completed.`,`${key}-message`);
  const proof=db.prepare("SELECT * FROM proofs WHERE stage='delivery' AND status='awaiting_confirmation' AND created_at BETWEEN ? AND ? ORDER BY id DESC LIMIT 1").get('2026-09-19T15:55:00.000Z','2026-09-19T16:05:00.000Z');
  const order381=db.prepare("SELECT * FROM orders WHERE external_id='SLA-381' COLLATE NOCASE").get();
  if(proof&&order381)await confirmProof(proof.id,order381.id);
}
async function requeueSept19SocialProof(){
  const key='repair-2026-09-19-social-proof-v2';
  if(db.prepare('SELECT 1 FROM report_runs WHERE run_key=?').get(key))return;
  const proof=db.prepare("SELECT * FROM proofs WHERE id=1 AND stage='delivery' AND status='confirmed'").get();
  const order=db.prepare("SELECT * FROM orders WHERE external_id='SLA-381' COLLATE NOCASE").get();
  if(!proof||!order||!fs.existsSync(proof.file_path))return;
  const vision=proof.vision_json?JSON.parse(proof.vision_json):{};
  enqueueSocialProof(proof,order,fs.readFileSync(proof.file_path).toString('base64'),vision,'proof-1-social-retry-v2');
  db.prepare('INSERT OR IGNORE INTO report_runs(run_key,sent_at) VALUES(?,?)').run(key,nowIso());
  console.log('Queued SLA-381 delivery proof for Social Agent retry');
}
setInterval(()=>processOutbox().catch(console.error),60000);
setInterval(()=>{
  if(localMinute()!==0)return;
  if(localHour()===MORNING_HOUR)summary('morning').catch(console.error);
},60000);

client.on('message',inbound);
client.on('qr',qr=>{latestQr=qr;console.log('Scheduling WhatsApp QR generated');});
client.on('authenticated',()=>{latestQr=null;console.log('Scheduling WhatsApp authenticated');});
client.on('ready',()=>{console.log('BTSA Scheduling Agent ready');repairSept19Updates().then(requeueSept19SocialProof).then(()=>summary('current','manual-clean-summary-2026-09-21-v1')).catch(error=>console.error('Scheduling startup task failed:',error?.message||String(error)));});
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
