const express=require('express');
const fs=require('fs');
const path=require('path');
const {DatabaseSync}=require('node:sqlite');

const app=express();
app.use(express.json({limit:'1mb'}));
const PORT=Number(process.env.PORT||4000);
const DB_DIR=process.env.DATA_DIR||'/app/data';
const DB_PATH=path.join(DB_DIR,'order-intake.sqlite');
const OPENAI_API_KEY=process.env.OPENAI_API_KEY||'';
const OPENAI_MODEL=process.env.OPENAI_MODEL||'gpt-4o-mini';
const ORDERS_GROUP_ID=process.env.ORDERS_GROUP_ID||'';
const WHATSAPP_SEND_URL=process.env.WHATSAPP_SEND_URL||'https://agent2whatsapp-production.up.railway.app/send';
const COMMIT_WEBHOOK_URL=process.env.COMMIT_WEBHOOK_URL||'';
const TZ='Africa/Johannesburg';
fs.mkdirSync(DB_DIR,{recursive:true});
const db=new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS drafts(
 author TEXT PRIMARY KEY,
 data TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'collecting',
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commits(
 message_id TEXT PRIMARY KEY,
 entry_id INTEGER NOT NULL,
 committed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sequence(
 id INTEGER PRIMARY KEY CHECK(id=1),
 next_id INTEGER NOT NULL
);
INSERT OR IGNORE INTO sequence(id,next_id) VALUES(1,900001);
`);

function now(){return new Date().toISOString();}
function getDraft(author){
 const r=db.prepare('SELECT * FROM drafts WHERE author=?').get(author);
 return r?{...r,data:JSON.parse(r.data)}:null;
}
function saveDraft(author,data,state='collecting'){
 db.prepare(`INSERT INTO drafts(author,data,state,updated_at) VALUES(?,?,?,?)
 ON CONFLICT(author) DO UPDATE SET data=excluded.data,state=excluded.state,updated_at=excluded.updated_at`)
 .run(author,JSON.stringify(data),state,now());
}
function clearDraft(author){db.prepare('DELETE FROM drafts WHERE author=?').run(author);}
function allocateEntryId(){
 db.exec('BEGIN IMMEDIATE');
 try{
  const r=db.prepare('SELECT next_id FROM sequence WHERE id=1').get();
  db.prepare('UPDATE sequence SET next_id=? WHERE id=1').run(r.next_id+1);
  db.exec('COMMIT'); return r.next_id;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
function missing(d){
 const req=[
  ['rate','rate'],['route','route'],['fullName','customer name'],
  ['make','bike make'],['model','bike model'],
  ['collectionContact','collection contact'],['collectionPhone','collection phone'],['collectionAddress1','collection address'],
  ['deliveryContact','delivery contact'],['deliveryPhone','delivery phone'],['deliveryAddress1','delivery address']
 ];
 return req.filter(([k])=>!String(d[k]||'').trim()).map(([,label])=>label);
}
function money(v){
 const n=Number(String(v??'').replace(/[^0-9.]/g,''));
 return Number.isFinite(n)&&n>0?n:null;
}
function cleanPhone(v){return String(v||'').replace(/[^0-9+]/g,'');}
async function send(text){
 const r=await fetch(WHATSAPP_SEND_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:ORDERS_GROUP_ID,text})});
 if(!r.ok)throw new Error('WhatsApp send failed '+r.status+': '+await r.text());
 return r.json();
}
function summary(d){
 return [
  '*Manual order draft*',
  '',
  `Route: ${d.route||'—'}`,
  `Rate: ${d.rate?'R'+Number(d.rate).toLocaleString('en-ZA'):'—'}`,
  `Customer: ${d.fullName||'—'}`,
  `Bike: ${[d.make,d.model].filter(Boolean).join(' ')||'—'}`,
  d.retailValue?`Retail value: R${Number(d.retailValue).toLocaleString('en-ZA')}`:null,
  '',
  '*Collection*',
  `${d.collectionContact||'—'} | ${d.collectionPhone||'—'}`,
  [d.collectionAddress1,d.collectionAddress2,d.collectionCity,d.collectionState,d.collectionPostal].filter(Boolean).join(', ')||'—',
  '',
  '*Delivery*',
  `${d.deliveryContact||'—'} | ${d.deliveryPhone||'—'}`,
  [d.deliveryAddress1,d.deliveryAddress2,d.deliveryCity,d.deliveryState,d.deliveryPostal].filter(Boolean).join(', ')||'—'
 ].filter(v=>v!==null).join('\n');
}
function responseText(p){
 if(p.output_text)return p.output_text;
 for(const i of p.output||[])for(const c of i.content||[])if(c.type==='output_text'&&c.text)return c.text;
 return '';
}
async function interpret(text,current){
 if(!OPENAI_API_KEY)throw new Error('OPENAI_API_KEY missing');
 const schema={type:'object',additionalProperties:false,properties:{
  intent:{type:'string',enum:['new_order','update','confirm','cancel','unrelated']},
  fields:{type:'object',additionalProperties:false,properties:{
   rate:{type:['number','null']},route:{type:['string','null']},fullName:{type:['string','null']},company:{type:['string','null']},
   phone:{type:['string','null']},email:{type:['string','null']},customerAddress1:{type:['string','null']},customerAddress2:{type:['string','null']},customerCity:{type:['string','null']},customerState:{type:['string','null']},customerPostal:{type:['string','null']},
   make:{type:['string','null']},model:{type:['string','null']},odometer:{type:['string','null']},retailValue:{type:['number','null']},extras:{type:['string','null']},
   collectionContact:{type:['string','null']},collectionPhone:{type:['string','null']},collectionAddress1:{type:['string','null']},collectionAddress2:{type:['string','null']},collectionCity:{type:['string','null']},collectionState:{type:['string','null']},collectionPostal:{type:['string','null']},
   deliveryContact:{type:['string','null']},deliveryPhone:{type:['string','null']},deliveryAddress1:{type:['string','null']},deliveryAddress2:{type:['string','null']},deliveryCity:{type:['string','null']},deliveryState:{type:['string','null']},deliveryPostal:{type:['string','null']}
  },required:['rate','route','fullName','company','phone','email','customerAddress1','customerAddress2','customerCity','customerState','customerPostal','make','model','odometer','retailValue','extras','collectionContact','collectionPhone','collectionAddress1','collectionAddress2','collectionCity','collectionState','collectionPostal','deliveryContact','deliveryPhone','deliveryAddress1','deliveryAddress2','deliveryCity','deliveryState','deliveryPostal']},
  note:{type:'string'}
 },required:['intent','fields','note']};
 const body={
  model:OPENAI_MODEL,
  input:[
   {role:'system',content:'You are the BTSA manual motorcycle-order intake parser. Interpret informal WhatsApp messages, speech-to-text, corrections and confirmations. Never invent missing facts. A new order starts when the user clearly says they are adding/booking/sending a new or manual order. If a draft exists, treat relevant details as updates. "confirm", "save", "add it", "correct", or equivalent after a complete draft means confirm. "cancel" or "discard" cancels the draft. Normal operations chatter is unrelated. Addresses may be split sensibly only when explicitly present. Return only structured data.'},
   {role:'user',content:`Current draft:\n${JSON.stringify(current||{})}\n\nNew WhatsApp message:\n${text}`}
  ],
  text:{format:{type:'json_schema',name:'manual_order_intake',strict:true,schema}}
 };
 const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:`Bearer ${OPENAI_API_KEY}`,'content-type':'application/json'},body:JSON.stringify(body)});
 if(!r.ok)throw new Error('OpenAI '+r.status+': '+await r.text());
 return JSON.parse(responseText(await r.json()));
}
function mergeFields(base,fields){
 const out={...(base||{})};
 for(const [k,v] of Object.entries(fields||{})){
  if(v===null||v===undefined||String(v).trim()==='')continue;
  out[k]=['rate','retailValue'].includes(k)?money(v):(['phone','collectionPhone','deliveryPhone'].includes(k)?cleanPhone(v):String(v).trim());
 }
 return out;
}
async function commit(author,d,messageId){
 if(messageId&&db.prepare('SELECT 1 FROM commits WHERE message_id=?').get(messageId))return {deduplicated:true};
 const entryId=allocateEntryId();
 const payload={entryId,...d,source:'manual-whatsapp',sourceMessageId:messageId||'',receivedAt:now()};
 const r=await fetch(COMMIT_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
 if(!r.ok)throw new Error('Commit webhook '+r.status+': '+await r.text());
 if(messageId)db.prepare('INSERT OR IGNORE INTO commits(message_id,entry_id,committed_at) VALUES(?,?,?)').run(messageId,entryId,now());
 clearDraft(author);
 await send(`✅ *Manual order saved — SLA-${entryId}*\n${d.route} | ${d.make} ${d.model} | R${Number(d.rate).toLocaleString('en-ZA')}`);
 return {entryId};
}
app.get('/health',(req,res)=>res.json({ok:true,openai:Boolean(OPENAI_API_KEY),commit:Boolean(COMMIT_WEBHOOK_URL),group:Boolean(ORDERS_GROUP_ID)}));
app.post('/inbound',async(req,res)=>{
 try{
  const p=req.body||{};
  if(p.from!==ORDERS_GROUP_ID||!p.text)return res.json({ignored:true});
  const author=String(p.author||p.phone||'group-controller');
  const existing=getDraft(author);
  const trigger=/\b(new|manual|add|book|booking|capture|create)\b[\s\S]{0,30}\border\b/i.test(p.text)||/\border\b[\s\S]{0,30}\b(new|manual|add|book|capture|create)\b/i.test(p.text);
  if(!existing&&!trigger)return res.json({ignored:true});
  const parsed=await interpret(p.text,existing?.data||null);
  if(parsed.intent==='unrelated'&&!existing)return res.json({ignored:true});
  if(parsed.intent==='cancel'){
   clearDraft(author); await send('Manual order draft cancelled.'); return res.json({cancelled:true});
  }
  const data=mergeFields(existing?.data||{},parsed.fields);
  const miss=missing(data);
  if(parsed.intent==='confirm'){
   if(miss.length){saveDraft(author,data);await send(`I still need: ${miss.join(', ')}.`);return res.json({waiting:true,missing:miss});}
   const out=await commit(author,data,p.messageId);return res.json({committed:true,...out});
  }
  saveDraft(author,data);
  if(miss.length){
   await send(`${summary(data)}\n\nStill need: *${miss.join(', ')}*\nSend the missing details in any format.`);
  }else{
   await send(`${summary(data)}\n\nEverything required is captured. Reply *confirm* to save this as a new order, or send any correction.`);
  }
  res.json({ok:true,missing:miss});
 }catch(e){console.error('Inbound error',e);res.status(500).json({error:e.message});}
});
app.listen(PORT,()=>console.log(`BTSA Order Intake listening on ${PORT}; db=${DB_PATH}`));
