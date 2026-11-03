"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {DatabaseSync} = require("node:sqlite");
const {installOutboundSafety} = require("./outbound-safety");
const {installSalesAgent} = require("./sales-agent");
test("outbound reservations deduplicate concurrent sends and persist across restart", async () => {
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"btsa-safety-")),"state.json");
 let sent=0;
 const client={sendMessage:async()=>{sent++;return {};}};
 const guard=installOutboundSafety(client,{file,perChat:2});
 await Promise.allSettled([client.sendMessage("g","one"),client.sendMessage("g","one")]);
 assert.equal(sent,1);
 await client.sendMessage("g","two");
 await assert.rejects(client.sendMessage("g","three"),/circuit tripped/);
 const next={sendMessage:async()=>{sent++;}};
 installOutboundSafety(next,{file,perChat:2});
 await assert.rejects(next.sendMessage("g","four"),/paused/);
 assert.equal(sent,2);
 guard.pause();
 await assert.rejects(client.sendMessage("other","five"),/paused/);
});
test("fresh test enquiries exclude old form facts and an unquoted correction selects only the latest case", async () => {
 process.env.SALES_ENABLED="true";process.env.SALES_TEST_MODE="true";process.env.SALES_TEST_PHONES="27760000000";
 const db=new DatabaseSync(":memory:");let sent=0;const cards=[],payloads=[];
 const customerClient={info:{wid:{user:"27720000000",_serialized:"27720000000@c.us"}},sendMessage:async()=>{sent++;}};
 const approvalClient={info:{},sendMessage:async(_to,text)=>{cards.push(text);return {id:{_serialized:"card-"+cards.length}};}};
 const norm=x=>String(x||"").replace(/\D/g,"");
 const agent=installSalesAgent({db,customerClient,approvalClient,approvalGroupId:"123@g.us",reasonerUrl:"https://example.invalid",token:"test",normalizePhone:norm,localPhone:norm,logEvent:()=>{}});
 db.prepare("INSERT INTO sales_approvals(case_ref,phone,customer_text,proposed_reply,created_at) VALUES(?,?,?,?,?)").run("SA-OLD","27760000000","old enquiry","R2750",new Date().toISOString());
 const savedFetch=global.fetch;
 global.fetch=async(url,opts)=>{payloads.push(JSON.parse(opts.body));return {ok:true,json:async()=>url.endsWith("customer")?{proposedReply:"What bike and which collection/delivery areas?"}:{intent:"revise",finalReply:"What bike are you moving, and which areas?",response:""}};};
 try {
  await agent.onCustomer({from:"27760000000@c.us",body:"What's your Durban to Johannesburg rate?",id:{_serialized:"false_new"},timestamp:Math.floor(Date.now()/1000)}, {id:317,name:"test",pickup:"OLD ADDRESS",dropoff:"OTHER OLD ADDRESS",bike_make:"test",estimated_price:"2750"},"27760000000");
  assert.equal(payloads[0].lead.pickup,undefined);assert.equal(payloads[0].lead.estimated_price,undefined);
  assert.equal(cards[0].includes("OLD ADDRESS"),false);assert.equal(cards[0].includes("2750"),false);
  assert.equal(db.prepare("SELECT state FROM sales_approvals WHERE case_ref='SA-OLD'").get().state,"superseded");
  await agent.onApproval({from:"123@g.us",author:"27720000000@c.us",_viaSharedBridge:true,id:{_serialized:"false_feedback"},body:"You need to qualify the lead first",timestamp:Math.floor(Date.now()/1000)});
  assert.equal(cards.length,2);assert.match(cards[1],/Revised reply/);assert.equal(sent,0);
  assert.notEqual(payloads[1].caseRef,"SA-OLD");
 } finally {global.fetch=savedFetch;db.close();}
});
test("global limit and uncertain sends fail closed",async()=>{
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"btsa-safety-")),"state.json");
 let sent=0;const c={sendMessage:async()=>{sent++;throw Error("uncertain");}};
 installOutboundSafety(c,{file,globalLimit:1});
 await assert.rejects(c.sendMessage("a","one"),/uncertain/);
 await assert.rejects(c.sendMessage("a","one"),/Duplicate/);
 await assert.rejects(c.sendMessage("b","two"),/Global/);
 assert.equal(sent,1);
});
test("sales ignores bot/local/untrusted events; duplicate and concurrent approvals send once",async()=>{
 process.env.SALES_ENABLED="true";process.env.SALES_TEST_MODE="true";process.env.SALES_TEST_PHONES="27760000000";
 const db=new DatabaseSync(":memory:");let groupSent=0,customerSent=0,reasons=0;
 const customerClient={info:{wid:{user:"27720000000"}},sendMessage:async()=>{customerSent++;return {id:{_serialized:"sent"}};}};
 const approvalClient={info:{},sendMessage:async()=>{groupSent++;return {id:{_serialized:"group"}};}};
 const normal=x=>String(x||"").replace(/\D/g,"");
 const agent=installSalesAgent({db,customerClient,approvalClient,approvalGroupId:"123@g.us",reasonerUrl:"https://example.invalid",token:"test",normalizePhone:normal,localPhone:normal,logEvent:()=>{}});
 const oldFetch=global.fetch;global.fetch=async()=>{reasons++;return {ok:true,json:async()=>({intent:"send",finalReply:"approved"})};};
 const message={from:"123@g.us",author:"owner@lid",_viaSharedBridge:true,_approvalAuthorPhone:"27720000000",id:{_serialized:"false_approval1"},body:"send it",fromMe:false,timestamp:Math.floor(Date.now()/1000)};
 try {
  await agent.onApproval({...message,_viaSharedBridge:false});
  await agent.onApproval({...message,fromMe:true});
  await agent.onApproval({...message,_approvalAuthorPhone:"27670000000"});
  await agent.onApproval({...message,timestamp:1});
  assert.equal(reasons,0);assert.equal(groupSent,0);
  await agent.onApproval(message);assert.equal(groupSent,0); // ambiguous: silence
  db.prepare("INSERT INTO sales_approvals(case_ref,phone,customer_text,proposed_reply,created_at) VALUES(?,?,?,?,?)").run("SA-TEST","27760000000","rate?","reply",new Date().toISOString());
  const a={...message,id:{_serialized:"false_approval2"}};
  const b={...message,id:{_serialized:"false_approval3"}};
  await Promise.all([agent.onApproval(a),agent.onApproval(a),agent.onApproval(b)]);
  assert.equal(customerSent,1);assert.equal(groupSent,1);
  assert.equal(db.prepare("SELECT state FROM sales_approvals").get().state,"sent");
  process.env.SALES_ENABLED="false";
  await agent.onApproval({...message,id:{_serialized:"false_disabled"}});
  assert.equal(customerSent,1);
 } finally {global.fetch=oldFetch;db.close();}
});
test("SLA links schedule one approval after 24 hours and a client reply cancels it",async()=>{
 process.env.SALES_ENABLED="true";process.env.SALES_TEST_MODE="true";process.env.SALES_TEST_PHONES="27760000000";
 const db=new DatabaseSync(":memory:");
 db.exec("CREATE TABLE leads(id INTEGER PRIMARY KEY, submitted_at TEXT, name TEXT, phone TEXT)");
 db.prepare("INSERT INTO leads(id,submitted_at,name,phone) VALUES(?,?,?,?)").run(1,new Date().toISOString(),"Sipho","760000000");
 const cards=[];
 const customerClient={info:{wid:{user:"27720000000"}},sendMessage:async()=>({id:{_serialized:"sent"}})};
 const approvalClient={info:{},sendMessage:async(_to,text)=>{cards.push(text);return {id:{_serialized:"sla-card"}};}};
 const norm=x=>String(x||"").replace(/\D/g,"");
 const local=x=>{const n=norm(x);return n.startsWith("27")?n.slice(2):n;};
 const agent=installSalesAgent({db,customerClient,approvalClient,approvalGroupId:"123@g.us",reasonerUrl:"https://example.invalid",token:"test",normalizePhone:norm,localPhone:local,logEvent:()=>{}});
 const outgoing={fromMe:true,body:"Please complete this: https://biketransport.co.za/booking-form/?ts=abc",id:{_serialized:"true_sla1"},timestamp:Math.floor(Date.now()/1000)};
 const oldFetch=global.fetch;
 global.fetch=async()=>({ok:true,json:async()=>({proposedReply:"Howzit Sipho, did you get a chance to complete the booking form? Shout if you need a hand.",category:"booking",confidence:1,notes:""})});
 try {
  assert.equal(await agent.onOutgoing(outgoing,"760000000"),true);
  assert.equal(await agent.onOutgoing(outgoing,"760000000"),false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sales_sla_followups").get().n,1);
  db.prepare("UPDATE sales_sla_followups SET due_at=?").run(new Date(Date.now()-1000).toISOString());
  assert.equal(await agent.processDueFollowups(),1);
  assert.equal(await agent.processDueFollowups(),0);
  assert.equal(cards.length,1);
  assert.match(cards[0],/SLA follow-up due/);
  await agent.onCustomer({fromMe:false,body:"Done thanks",id:{_serialized:"false_reply"},timestamp:Math.floor(Date.now()/1000)},null,"760000000");
  assert.equal(db.prepare("SELECT state FROM sales_sla_followups").get().state,"cancelled_reply");
  assert.equal(db.prepare("SELECT state FROM sales_approvals").get().state,"superseded");
 } finally {global.fetch=oldFetch;db.close();}
});
test("successful SLA submission cancels the reminder and sends one confirmation",async()=>{
 const db=new DatabaseSync(":memory:");let customerSent=0;const messages=[];
 const customerClient={info:{wid:{user:"27720000000"}},sendMessage:async(to,text)=>{customerSent++;messages.push({to,text});return {id:{_serialized:"confirmed-1"}};}};
 const approvalClient={info:{},sendMessage:async()=>({id:{_serialized:"group"}})};
 const norm=x=>{let n=String(x||"").replace(/\D/g,"");if(n.startsWith("0"))n=`27${n.slice(1)}`;if(n.length===9)n=`27${n}`;return n;};
 const local=x=>{let n=norm(x);if(n.startsWith("0"))n=`27${n.slice(1)}`;return n.startsWith("27")?n.slice(2):n;};
 const agent=installSalesAgent({db,customerClient,approvalClient,approvalGroupId:"123@g.us",reasonerUrl:"https://example.invalid",token:"test",normalizePhone:norm,localPhone:local,logEvent:()=>{}});
 const stamp=new Date().toISOString();
 const f=db.prepare("INSERT INTO sales_sla_followups(phone,source_message_id,sla_message,sent_at,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
  .run("760000000","true_link","booking link",stamp,new Date(Date.now()+86400000).toISOString(),stamp,stamp);
 db.prepare("INSERT INTO sales_approvals(case_ref,phone,customer_text,proposed_reply,followup_id,created_at) VALUES(?,?,?,?,?,?)")
  .run("SA-FOLLOWUP","760000000","No reply","Reminder",Number(f.lastInsertRowid),stamp);
 try {
  const first=agent.onOrderConfirmed({slaRef:"SLA-501",phone:"27760000000",name:"Sipho"});
  const duplicate=agent.onOrderConfirmed({slaRef:"sla-501",phone:"0760000000",name:"Sipho"});
  assert.equal(first.deduplicated,false);assert.equal(duplicate.deduplicated,true);
  assert.equal(db.prepare("SELECT state FROM sales_sla_followups").get().state,"cancelled_order");
  assert.equal(db.prepare("SELECT state FROM sales_approvals").get().state,"superseded");
  assert.equal(await agent.processOrderConfirmations(),1);
  assert.equal(await agent.processOrderConfirmations(),0);
  assert.equal(customerSent,1);assert.equal(messages[0].to,"27760000000@c.us");
  assert.match(messages[0].text,/received your booking form/);assert.match(messages[0].text,/invoice, including the banking details/);
  assert.match(messages[0].text,/Payment is due upfront or at collection/);assert.match(messages[0].text,/I’ll confirm/);
  assert.doesNotMatch(messages[0].text,/SLA-501|Booking reference/);
  assert.equal(db.prepare("SELECT state FROM sales_order_confirmations").get().state,"sent");
 } finally {db.close();}
});
test("sales uses WhatsApp history and all matching lead rows, and suppresses acknowledgements",async()=>{
 process.env.SALES_ENABLED="true";process.env.SALES_TEST_MODE="false";
 const db=new DatabaseSync(":memory:");
 db.exec(`CREATE TABLE leads(
  id INTEGER PRIMARY KEY, submitted_at TEXT, first_touch_sent_at TEXT, name TEXT, phone TEXT,
  pickup TEXT, dropoff TEXT, bike_type TEXT, bike_make TEXT, bike_model TEXT,
  urgency TEXT, estimated_price TEXT
 )`);
 db.prepare("INSERT INTO leads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(1,"2026-11-02T04:00:00.000Z",null,"Isalvan","760000000","Sabie","Centurion","Standard","BMW","F 800 GS","7-10 Days","5250");
 db.prepare("INSERT INTO leads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(2,"2026-11-03T04:00:00.000Z",null,"Isalvan","760000000","Sabie","Centurion","Standard","BMW","F 800 GS","7-10 Days","5600");
 const cards=[],payloads=[];
 const customerClient={info:{wid:{user:"27720000000"}},sendMessage:async()=>({id:{_serialized:"sent"}})};
 const approvalClient={info:{},sendMessage:async(_to,text)=>{cards.push(text);return {id:{_serialized:`card-${cards.length}`}};}};
 const norm=x=>{let n=String(x||"").replace(/\D/g,"");if(n.startsWith("0"))n=`27${n.slice(1)}`;if(n.length===9)n=`27${n}`;return n;};
 const local=x=>{const n=norm(x);return n.startsWith("27")?n.slice(2):n;};
 const agent=installSalesAgent({db,customerClient,approvalClient,approvalGroupId:"123@g.us",reasonerUrl:"https://example.invalid",token:"test",normalizePhone:norm,localPhone:local,logEvent:()=>{}});
 const savedFetch=global.fetch;
 global.fetch=async(_url,opts)=>{const p=JSON.parse(opts.body);payloads.push(p);return {ok:true,json:async()=>({action:"no_reply",proposedReply:"",category:"other",confidence:1,notes:"Acknowledgement after a polite close"})};};
 const stamp=Math.floor(Date.now()/1000);
 const manual={fromMe:true,body:"No problem, when you're ready let me know and I'll work out the best route and rate for you then 💪",id:{_serialized:"true_manual_close"},timestamp:stamp};
 const thumb={fromMe:false,body:"👍",id:{_serialized:"false_thumb"},timestamp:stamp,getChat:async()=>({fetchMessages:async()=>[
  {...manual,timestamp:stamp-10},
  {fromMe:false,body:"👍",id:{_serialized:"false_thumb"},timestamp:stamp}
 ]})};
 try {
  assert.equal(await agent.onOutgoing(manual,"760000000"),true);
  const latest=db.prepare("SELECT * FROM leads WHERE id=2").get();
  await agent.onCustomer(thumb,latest,"760000000");
  assert.equal(cards.length,0);
  assert.equal(payloads.length,1);
  assert.equal(payloads[0].leadInquiries.length,2);
  assert.equal(payloads[0].leadInquiries[0].bike_model,"F 800 GS");
  assert.ok(payloads[0].history.some(x=>x.direction==="duane"&&/when you're ready/.test(x.body)));
 } finally {global.fetch=savedFetch;db.close();}
});
