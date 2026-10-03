const express=require('express');
const fs=require('fs');
const path=require('path');
const {DatabaseSync}=require('node:sqlite');

const app=express();
app.use(express.json({limit:'2mb'}));
const PORT=Number(process.env.PORT||4000);
const DB_DIR=process.env.DATA_DIR||'/app/data';
const DB_PATH=path.join(DB_DIR,'order-intake.sqlite');
const OPENAI_API_KEY=process.env.OPENAI_API_KEY||'';
const OPENAI_MODEL=process.env.OPENAI_MODEL||'gpt-4o-mini';
const ORDERS_GROUP_ID=process.env.ORDERS_GROUP_ID||'';
const WHATSAPP_SEND_URL=process.env.WHATSAPP_SEND_URL||'https://agent2whatsapp-production.up.railway.app/send';
const COMMIT_WEBHOOK_URL=process.env.COMMIT_WEBHOOK_URL||'';
const HISTORY_WEBHOOK_URL=process.env.HISTORY_WEBHOOK_URL||'';

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
 entry_id TEXT NOT NULL,
 committed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manual_sequence(
 id INTEGER PRIMARY KEY CHECK(id=1),
 next_id INTEGER NOT NULL
);
INSERT OR IGNORE INTO manual_sequence(id,next_id) VALUES(1,1);
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
function allocateSlaRef(){
 db.exec('BEGIN IMMEDIATE');
 try{
  const r=db.prepare('SELECT next_id FROM manual_sequence WHERE id=1').get();
  db.prepare('UPDATE manual_sequence SET next_id=? WHERE id=1').run(r.next_id+1);
  db.exec('COMMIT');
  return 'M-'+String(r.next_id).padStart(4,'0');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
function missing(d){
 const req=[
  ['rate','rate'],['fullName','customer name'],['make','bike make'],['model','bike model'],
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
function norm(v){return String(v||'').toLowerCase().replace(/[^a-z0-9+]+/g,' ').replace(/\s+/g,' ').trim();}
function words(v){return new Set(norm(v).split(' ').filter(x=>x.length>=3));}
async function send(text){
 const r=await fetch(WHATSAPP_SEND_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:ORDERS_GROUP_ID,text})});
 if(!r.ok)throw new Error('WhatsApp send failed '+r.status+': '+await r.text());
 return r.json();
}
function routeFromAddresses(d){
 const from=d.collectionCity||d.collectionState||'';
 const to=d.deliveryCity||d.deliveryState||'';
 return from&&to?`${from} to ${to}`:(d.route||'');
}
function summary(d){
 return [
  '*Manual order draft*',
  '',
  d.slaRef?`SLA Ref: ${d.slaRef}`:null,
  `Route: ${d.route||routeFromAddresses(d)||'—'}`,
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
function rowToOrder(r){
 const v=i=>r[i]??'';
 return {
  entryId:v(0),status:v(1),rate:money(v(3)),route:v(4),fullName:v(5),company:v(6),phone:cleanPhone(v(7)),email:v(8),
  customerAddress1:v(9),customerAddress2:v(10),customerCity:v(11),customerState:v(12),customerPostal:v(13),
  make:v(15),model:v(16),odometer:v(17),retailValue:money(v(18)),extras:v(19),
  collectionContact:v(20),collectionPhone:cleanPhone(v(21)),collectionAddress1:v(22),collectionAddress2:v(23),collectionCity:v(24),collectionState:v(25),collectionPostal:v(26),
  deliveryPhone:cleanPhone(v(28)),deliveryContact:v(29),deliveryAddress1:v(30),deliveryAddress2:v(31),deliveryCity:v(32),deliveryState:v(33),deliveryPostal:v(34),
  receivedAt:v(36),sourceId:v(37),quickbooksInvoiceId:v(38),slaRef:v(39)
 };
}
async function historyRows(){
 if(!HISTORY_WEBHOOK_URL)return [];
 const r=await fetch(HISTORY_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
 if(!r.ok)throw new Error('History lookup '+r.status+': '+await r.text());
 let body=await r.json();
 if(typeof body==='string')body=JSON.parse(body);
 if(typeof body.body==='string'){try{body=JSON.parse(body.body);}catch{}}
 const vals=body.values||body.body?.values||[];
 return Array.isArray(vals)?vals.slice(1).map(rowToOrder).filter(x=>x.entryId||x.slaRef):[];
}
function scoreOrder(o,q){
 const nq=norm(q); if(!nq)return 0;
 let s=0;
 const exact=[o.slaRef,o.entryId,o.phone,o.collectionPhone,o.deliveryPhone].filter(Boolean);
 for(const x of exact)if(norm(x)&&nq.includes(norm(x)))s+=12;
 const strong=[o.fullName,o.company,o.collectionContact,o.deliveryContact].filter(Boolean);
 for(const x of strong)if(norm(x).length>=4&&nq.includes(norm(x)))s+=7;
 const medium=[o.route,o.make,o.model].filter(Boolean);
 for(const x of medium)if(norm(x).length>=3&&nq.includes(norm(x)))s+=4;
 const qw=words(q);
 for(const x of [o.fullName,o.company,o.collectionContact,o.deliveryContact,o.route,o.make,o.model]){
  for(const w of words(x))if(qw.has(w))s+=1;
 }
 if(o.rate&&nq.includes(String(o.rate)))s+=2;
 return s;
}
async function candidatesFor(text,quoted){
 const rows=await historyRows();
 const q=[quoted,text].filter(Boolean).join('\n');
 return rows.map(o=>({o,score:scoreOrder(o,q)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,5).map(x=>({...x.o,_score:x.score}));
}
function swapOrder(o){
 return {...o,
  collectionContact:o.deliveryContact,collectionPhone:o.deliveryPhone,collectionAddress1:o.deliveryAddress1,collectionAddress2:o.deliveryAddress2,collectionCity:o.deliveryCity,collectionState:o.deliveryState,collectionPostal:o.deliveryPostal,
  deliveryContact:o.collectionContact,deliveryPhone:o.collectionPhone,deliveryAddress1:o.collectionAddress1,deliveryAddress2:o.collectionAddress2,deliveryCity:o.collectionCity,deliveryState:o.collectionState,deliveryPostal:o.collectionPostal,
  route:[o.deliveryCity||o.deliveryState,o.collectionCity||o.collectionState].filter(Boolean).join(' to ')
 };
}
async function interpret(text,current,quoted,candidates){
 if(!OPENAI_API_KEY)throw new Error('OPENAI_API_KEY missing');
 const schema={type:'object',additionalProperties:false,properties:{
  intent:{type:'string',enum:['new_order','update','confirm','cancel','unrelated']},
  historyIndex:{type:['integer','null']},reverseHistory:{type:'boolean'},needsClarification:{type:'boolean'},clarification:{type:'string'},
  fields:{type:'object',additionalProperties:false,properties:{
   rate:{type:['number','null']},route:{type:['string','null']},fullName:{type:['string','null']},company:{type:['string','null']},
   phone:{type:['string','null']},email:{type:['string','null']},customerAddress1:{type:['string','null']},customerAddress2:{type:['string','null']},customerCity:{type:['string','null']},customerState:{type:['string','null']},customerPostal:{type:['string','null']},
   make:{type:['string','null']},model:{type:['string','null']},odometer:{type:['string','null']},retailValue:{type:['number','null']},extras:{type:['string','null']},
   collectionContact:{type:['string','null']},collectionPhone:{type:['string','null']},collectionAddress1:{type:['string','null']},collectionAddress2:{type:['string','null']},collectionCity:{type:['string','null']},collectionState:{type:['string','null']},collectionPostal:{type:['string','null']},
   deliveryContact:{type:['string','null']},deliveryPhone:{type:['string','null']},deliveryAddress1:{type:['string','null']},deliveryAddress2:{type:['string','null']},deliveryCity:{type:['string','null']},deliveryState:{type:['string','null']},deliveryPostal:{type:['string','null']}
  },required:['rate','route','fullName','company','phone','email','customerAddress1','customerAddress2','customerCity','customerState','customerPostal','make','model','odometer','retailValue','extras','collectionContact','collectionPhone','collectionAddress1','collectionAddress2','collectionCity','collectionState','collectionPostal','deliveryContact','deliveryPhone','deliveryAddress1','deliveryAddress2','deliveryCity','deliveryState','deliveryPostal']}
 },required:['intent','historyIndex','reverseHistory','needsClarification','clarification','fields']};
 const system=`You are the BTSA manual-order controller. Understand informal WhatsApp messages and speech-to-text. Never invent facts.
A quoted/replied-to previous order is the strongest reference. Historical candidates are numbered from 0. Select historyIndex only when the user's reference clearly identifies that order/customer; otherwise set needsClarification=true.
"reverse", "return", "other way", or equivalent applied to a previous order means reverseHistory=true: use the old order as the base and swap collection and delivery completely.
"same customer/bike/order" means reuse historical details unless the user explicitly changes them.
If a complete draft exists, "add to SLA sheet", "save it", "process it", "add it", "correct", "confirm" or equivalent is intent=confirm.
Normal group chatter is unrelated. Never require the literal word confirm if the user's instruction clearly authorizes saving.
The collection/delivery data is authoritative. Do not preserve stale route wording from an older order when endpoints changed.`;
 const body={model:OPENAI_MODEL,input:[
  {role:'system',content:system},
  {role:'user',content:`Current draft:\n${JSON.stringify(current||{})}\n\nQuoted WhatsApp message:\n${quoted||'(none)'}\n\nHistorical candidates:\n${JSON.stringify(candidates)}\n\nNew message:\n${text}`}
 ],text:{format:{type:'json_schema',name:'manual_order_intake_v2',strict:true,schema}}};
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
 const slaRef=allocateSlaRef();
 const final={...d,slaRef,route:routeFromAddresses(d)||d.route};
 const payload={...final,source:'manual-whatsapp',sourceMessageId:messageId||'',receivedAt:now()};
 const r=await fetch(COMMIT_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
 if(!r.ok)throw new Error('Commit webhook '+r.status+': '+await r.text());
 if(messageId)db.prepare('INSERT OR IGNORE INTO commits(message_id,entry_id,committed_at) VALUES(?,?,?)').run(messageId,slaRef,now());
 clearDraft(author);
 await send(`✅ *Manual order saved — ${slaRef}*\n${final.route} | ${final.make} ${final.model} | R${Number(final.rate).toLocaleString('en-ZA')}`);
 return {slaRef};
}
app.get('/health',(req,res)=>res.json({ok:true,openai:Boolean(OPENAI_API_KEY),commit:Boolean(COMMIT_WEBHOOK_URL),history:Boolean(HISTORY_WEBHOOK_URL),group:Boolean(ORDERS_GROUP_ID)}));
app.post('/inbound',async(req,res)=>{
 try{
  const p=req.body||{};
  if(p.from!==ORDERS_GROUP_ID||!p.text)return res.json({ignored:true});
  const author=String(p.author||p.phone||'group-controller');
  const existing=getDraft(author);
  const quoted=String(p.quotedText||'');
  const trigger=/\b(new|manual|add|book|booking|capture|create|repeat|reverse|return)\b[\s\S]{0,40}\border\b/i.test(p.text)
    ||/\border\b[\s\S]{0,40}\b(new|manual|add|book|capture|create|repeat|reverse|return)\b/i.test(p.text)
    ||(quoted&&/\b(reverse|repeat|return|same|again|new|book|add)\b/i.test(p.text));
  if(!existing&&!trigger)return res.json({ignored:true});

  const candidates=await candidatesFor(p.text,quoted);
  const parsed=await interpret(p.text,existing?.data||null,quoted,candidates);
  if(parsed.intent==='unrelated'&&!existing)return res.json({ignored:true});
  if(parsed.intent==='cancel'){
   clearDraft(author); await send('Manual order draft cancelled.'); return res.json({cancelled:true});
  }
  if(parsed.needsClarification){
   await send(parsed.clarification||'I found more than one possible previous order. Which customer/order should I use?');
   return res.json({waiting:true,clarification:true});
  }

  let base=existing?.data||{};
  if(Number.isInteger(parsed.historyIndex)&&parsed.historyIndex>=0&&parsed.historyIndex<candidates.length){
   const hist={...candidates[parsed.historyIndex]};
   delete hist._score;
   base=parsed.reverseHistory?swapOrder(hist):hist;
   delete base.entryId; delete base.slaRef; delete base.status; delete base.sourceId; delete base.quickbooksInvoiceId; delete base.receivedAt;
  }
  let data=mergeFields(base,parsed.fields);
  data.route=routeFromAddresses(data)||data.route;
  const miss=missing(data);

  if(parsed.intent==='confirm'){
   if(miss.length){saveDraft(author,data);await send(`I still need: ${miss.join(', ')}.`);return res.json({waiting:true,missing:miss});}
   const out=await commit(author,data,p.messageId);return res.json({committed:true,...out});
  }

  saveDraft(author,data);
  if(miss.length){
   await send(`${summary(data)}\n\nStill need: *${miss.join(', ')}*\nSend the missing details in any format.`);
  }else{
   await send(`${summary(data)}\n\nEverything required is captured. Tell me to *add/save/process it* or send any correction.`);
  }
  res.json({ok:true,missing:miss,historyCandidates:candidates.length});
 }catch(e){console.error('Inbound error',e);res.status(500).json({error:e.message});}
});
app.listen(PORT,()=>console.log(`BTSA Order Intake listening on ${PORT}; db=${DB_PATH}`));
