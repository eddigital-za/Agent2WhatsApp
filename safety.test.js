"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {DatabaseSync} = require("node:sqlite");
const {installOutboundSafety} = require("./outbound-safety");
const {installSalesAgent} = require("./sales-agent");
const {resolveWhatsAppRecipient,findExactOutboundReceipts} = require("./whatsapp-recipient");
const {selectFirstTouchCandidates} = require("./first-touch-store");
test("outbound phone resolution prefers the WhatsApp LID and rejects unknown numbers before send",async()=>{
 const normalize=x=>String(x||"").replace(/\D/g,"");
 const lidClient={getContactLidAndPhone:async ids=>[{pn:ids[0],lid:"123456789@lid"}],getNumberId:async()=>{throw Error("fallback must not run");}};
 assert.equal(await resolveWhatsAppRecipient(lidClient,"+27 72 000 0000",normalize),"123456789@lid");
 const unknownClient={getContactLidAndPhone:async()=>[{}],getNumberId:async()=>null};
 await assert.rejects(resolveWhatsAppRecipient(unknownClient,"27720000000",normalize),/not registered/);
});
test("exact outbound receipt lookup returns only matching sent text",async()=>{
 const client={pupPage:{evaluate:async(_fn,args)=>args.text==="expected"?["true_lid_message"]:[]}};
 assert.deepEqual(await findExactOutboundReceipts(client,"123@lid","expected",Date.now()-5000),["true_lid_message"]);
});
test("first-touch recovery selects yesterday and new leads without replaying older leads",()=>{
 const db=new DatabaseSync(":memory:");
 db.exec("CREATE TABLE leads(id INTEGER PRIMARY KEY,submitted_at TEXT,first_touch_due_at TEXT,first_touch_sent_at TEXT,replied_at TEXT,duplicate_suppressed_at TEXT)");
 const add=db.prepare("INSERT INTO leads(id,submitted_at,first_touch_due_at) VALUES(?,?,?)");
 add.run(1,"2026-11-08T21:59:59.999Z","2026-11-08T22:00:00.000Z");
 add.run(2,"2026-11-08T22:00:00.000Z","2026-11-08T22:01:00.000Z");
 add.run(3,"2026-11-10T04:00:00.000Z","2026-11-10T04:01:00.000Z");
 assert.deepEqual(selectFirstTouchCandidates(db,"2026-11-08T22:00:00.000Z","2026-11-10T05:00:00.000Z").map(row=>row.id),[2,3]);
 db.close();
});
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
 assert.equal(guard.resume("website-leads-v1"),true);
 await client.sendMessage("other","five");
 assert.equal(sent,3);
});
test("fresh test enquiries exclude old form facts and an unquoted correction selects only the latest case", async () => {
 process.env.SALES_ENABLED="true";process.env.SALES_CONVERSATION_ENABLED="true";process.env.SALES_TEST_MODE="true";process.env.SALES_TEST_PHONES="27760000000";process.env.SALES_REPLY_DEBOUNCE_SECONDS="0";
 const db=new DatabaseSync(":memory:");let sent=0;const cards=[],payloads=[];
	 db.exec("CREATE TABLE leads(id INTEGER PRIMARY KEY,submitted_at TEXT,received_at TEXT,name TEXT,phone TEXT,pickup TEXT,dropoff TEXT,bike_make TEXT,estimated_price TEXT)");
	 db.prepare("INSERT INTO leads VALUES(?,?,?,?,?,?,?,?,?)").run(317,new Date().toISOString(),new Date().toISOString(),"test","27760000000","OLD ADDRESS","OTHER OLD ADDRESS","test","2750");
 const customerClient={info:{wid:{user:"27720000000",_serialized:"27720000000@c.us"}},sendMessage:async()=>{sent++;}};
 const approvalClient={info:{},sendMessage:async(_to,text)=>{cards.push(text);return {id:{_serialized:"card-"+cards.length}};}};
 const norm=x=>String(x||"").replace(/\D/g,"");
 const agent=installSalesAgent({db,customerClient,approvalClient,approvalGroupId:"123@g.us",reasonerUrl:"https://example.invalid",token:"test",normalizePhone:norm,localPhone:norm,logEvent:()=>{}});
 db.prepare("INSERT INTO sales_approvals(case_ref,phone,customer_text,proposed_reply,created_at) VALUES(?,?,?,?,?)").run("SA-OLD","27760000000","old enquiry","R2750",new Date().toISOString());
 const savedFetch=global.fetch;
	 global.fetch=async(url,opts)=>{payloads.push(JSON.parse(opts.body));return {ok:true,json:async()=>url.endsWith("customer")?{action:"reply",salesMove:"qualify",proposedReply:"What bike and which collection/delivery areas?",ownerQuestion:"",category:"price",confidence:1,notes:""}:{intent:"revise",finalReply:"What bike are you moving, and which areas?",response:""}};};
 try {
  await agent.onCustomer({from:"27760000000@c.us",body:"What's your Durban to Johannesburg rate?",id:{_serialized:"false_new"},timestamp:Math.floor(Date.now()/1000)}, {id:317,name:"test",pickup:"OLD ADDRESS",dropoff:"OTHER OLD ADDRESS",bike_make:"test",estimated_price:"2750"},"27760000000");
	  await agent.processInboundConversations();
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
test("corrected SLA submissions suppress repeated confirmations but a different bike still sends",async()=>{
 const db=new DatabaseSync(":memory:");const messages=[];
 const customerClient={info:{wid:{user:"27720000000"}},sendMessage:async(to,text)=>{messages.push({to,text});return {id:{_serialized:`confirmed-${messages.length}`}};}};
 const approvalClient={info:{},sendMessage:async()=>({id:{_serialized:"group"}})};
 const norm=x=>{let n=String(x||"").replace(/\D/g,"");if(n.startsWith("0"))n=`27${n.slice(1)}`;if(n.length===9)n=`27${n}`;return n;};
 const local=x=>{const n=norm(x);return n.startsWith("27")?n.slice(2):n;};
 const agent=installSalesAgent({db,customerClient,approvalClient,approvalGroupId:"123@g.us",reasonerUrl:"https://example.invalid",token:"test",normalizePhone:norm,localPhone:local,logEvent:()=>{}});
 try {
  const first=agent.onOrderConfirmed({slaRef:"SLA-525",phone:"+27606226069",name:"Seleta Johny Modiba",bike:"Honda CBR",route:"DBN to JHB",odometer:"69,000",value:"70,000"});
  const correction=agent.onOrderConfirmed({slaRef:"SLA-526",phone:"0606226069",name:"Johny Modiba",bike:"Honda Cbr",route:"DBN to JHB",odometer:"69000",value:"R70 000"});
  const secondBike=agent.onOrderConfirmed({slaRef:"SLA-527",phone:"0606226069",name:"Johny Modiba",bike:"Yamaha MT-07",route:"DBN to JHB",odometer:"12,000",value:"85,000"});
  assert.equal(first.deduplicated,false);
  assert.equal(correction.deduplicated,true);
  assert.equal(correction.confirmation.state,"suppressed_duplicate");
  assert.equal(correction.confirmation.duplicate_of_sla_ref,"SLA-525");
  assert.equal(secondBike.deduplicated,false);
  assert.equal(await agent.processOrderConfirmations(),2);
  assert.equal(messages.length,2);
  assert.deepEqual(db.prepare("SELECT sla_ref,state,duplicate_of_sla_ref FROM sales_order_confirmations ORDER BY id").all().map(row=>({...row})),[
   {sla_ref:"SLA-525",state:"sent",duplicate_of_sla_ref:null},
   {sla_ref:"SLA-526",state:"suppressed_duplicate",duplicate_of_sla_ref:"SLA-525"},
   {sla_ref:"SLA-527",state:"sent",duplicate_of_sla_ref:null},
  ]);
 } finally {db.close();}
});
test("sales uses WhatsApp history and all matching lead rows, and suppresses acknowledgements",async()=>{
 process.env.SALES_ENABLED="true";process.env.SALES_CONVERSATION_ENABLED="true";process.env.SALES_TEST_MODE="false";process.env.SALES_LEAD_COHORT_START="2026-11-01T00:00:00.000Z";process.env.SALES_REPLY_DEBOUNCE_SECONDS="0";
 const db=new DatabaseSync(":memory:");
 db.exec(`CREATE TABLE leads(
  id INTEGER PRIMARY KEY, submitted_at TEXT, received_at TEXT, first_touch_sent_at TEXT, name TEXT, phone TEXT,
  pickup TEXT, dropoff TEXT, bike_type TEXT, bike_make TEXT, bike_model TEXT,
  urgency TEXT, estimated_price TEXT
 )`);
 db.prepare("INSERT INTO leads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(1,"2026-11-02T04:00:00.000Z","2026-11-02T04:00:00.000Z",null,"Isalvan","760000000","Sabie","Centurion","Standard","BMW","F 800 GS","7-10 Days","5250");
 db.prepare("INSERT INTO leads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(2,"2026-11-03T04:00:00.000Z","2026-11-03T04:00:00.000Z",null,"Isalvan","760000000","Sabie","Centurion","Standard","BMW","F 800 GS","7-10 Days","5600");
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
	  await agent.processInboundConversations();
  assert.equal(cards.length,0);
  assert.equal(payloads.length,1);
  assert.equal(payloads[0].leadInquiries.length,2);
  assert.equal(payloads[0].leadInquiries[0].bike_model,"F 800 GS");
  assert.ok(payloads[0].history.some(x=>x.direction==="duane"&&/when you're ready/.test(x.body)));
 } finally {global.fetch=savedFetch;db.close();}
});
test("don't reply deterministically cancels a pending case without calling the reasoner",async()=>{
 process.env.SALES_ENABLED="true";
 const db=new DatabaseSync(":memory:");let customerSent=0,reasonCalls=0;const cards=[];
 const customerClient={info:{wid:{user:"27720000000",_serialized:"27720000000@c.us"}},sendMessage:async()=>{customerSent++;}};
 const approvalClient={info:{},sendMessage:async(_to,text)=>{cards.push(text);return {id:{_serialized:"ack"}};}};
 const norm=x=>String(x||"").replace(/\D/g,"");
 const agent=installSalesAgent({db,customerClient,approvalClient,approvalGroupId:"123@g.us",reasonerUrl:"https://example.invalid",token:"test",normalizePhone:norm,localPhone:norm,logEvent:()=>{}});
 db.prepare("INSERT INTO sales_approvals(case_ref,phone,customer_text,proposed_reply,created_at) VALUES(?,?,?,?,?)")
  .run("SA-CANCEL","27760000000","When are you collecting?","I'll collect this afternoon",new Date().toISOString());
 const savedFetch=global.fetch;global.fetch=async()=>{reasonCalls++;return {ok:true,json:async()=>({intent:"send",finalReply:"I'll collect this afternoon"})};};
 try {
  await agent.onApproval({from:"123@g.us",author:"27720000000@c.us",_viaSharedBridge:true,fromMe:false,id:{_serialized:"false_cancel"},body:"Don't reply",timestamp:Math.floor(Date.now()/1000)});
  assert.equal(reasonCalls,0);assert.equal(customerSent,0);
  assert.equal(db.prepare("SELECT state FROM sales_approvals WHERE case_ref='SA-CANCEL'").get().state,"cancelled");
  assert.match(cards[0],/won't reply/);
 } finally {global.fetch=savedFetch;db.close();}
});
test("model cannot send without an explicit owner send instruction",async()=>{
 process.env.SALES_ENABLED="true";
 const db=new DatabaseSync(":memory:");let customerSent=0;const cards=[];
 const customerClient={info:{wid:{user:"27720000000",_serialized:"27720000000@c.us"}},sendMessage:async()=>{customerSent++;}};
 const approvalClient={info:{},sendMessage:async(_to,text)=>{cards.push(text);return {id:{_serialized:"ack"}};}};
 const norm=x=>String(x||"").replace(/\D/g,"");
 const agent=installSalesAgent({db,customerClient,approvalClient,approvalGroupId:"123@g.us",reasonerUrl:"https://example.invalid",token:"test",normalizePhone:norm,localPhone:norm,logEvent:()=>{}});
 db.prepare("INSERT INTO sales_approvals(case_ref,phone,customer_text,proposed_reply,created_at) VALUES(?,?,?,?,?)")
  .run("SA-NOAUTH","27760000000","When are you collecting?","I'll collect this afternoon",new Date().toISOString());
 const savedFetch=global.fetch;global.fetch=async()=>({ok:true,json:async()=>({intent:"send",finalReply:"I'll collect this afternoon",response:""})});
 try {
  await agent.onApproval({from:"123@g.us",author:"27720000000@c.us",_viaSharedBridge:true,fromMe:false,id:{_serialized:"false_noauth"},body:"Looks good",timestamp:Math.floor(Date.now()/1000)});
  assert.equal(customerSent,0);
  assert.equal(db.prepare("SELECT state FROM sales_approvals WHERE case_ref='SA-NOAUTH'").get().state,"pending");
  assert.match(cards[0],/haven't sent anything/);
 } finally {global.fetch=savedFetch;db.close();}
});
test("a transcribed voice instruction not to reply cancels without sending",async()=>{
 process.env.SALES_ENABLED="true";
 const db=new DatabaseSync(":memory:");let customerSent=0;
 const customerClient={info:{wid:{user:"27720000000",_serialized:"27720000000@c.us"}},sendMessage:async()=>{customerSent++;}};
 const approvalClient={info:{},sendMessage:async()=>({id:{_serialized:"ack"}})};
 const norm=x=>String(x||"").replace(/\D/g,"");
 const agent=installSalesAgent({db,customerClient,approvalClient,approvalGroupId:"123@g.us",reasonerUrl:"https://example.invalid",token:"test",normalizePhone:norm,localPhone:norm,logEvent:()=>{}});
 db.prepare("INSERT INTO sales_approvals(case_ref,phone,customer_text,proposed_reply,created_at) VALUES(?,?,?,?,?)")
  .run("SA-VOICE-CANCEL","27760000000","When are you collecting?","I'll collect this afternoon",new Date().toISOString());
 const savedFetch=global.fetch;global.fetch=async()=>({ok:true,json:async()=>({intent:"cancel",finalReply:"",response:"",transcript:"Do not reply to him"})});
 try {
  await agent.onApproval({from:"123@g.us",author:"27720000000@c.us",_viaSharedBridge:true,fromMe:false,id:{_serialized:"false_voice_cancel"},body:"",hasMedia:true,downloadMedia:async()=>({data:"AA==",mimetype:"audio/ogg"}),timestamp:Math.floor(Date.now()/1000)});
  assert.equal(customerSent,0);
  assert.equal(db.prepare("SELECT state FROM sales_approvals WHERE case_ref='SA-VOICE-CANCEL'").get().state,"cancelled");
 } finally {global.fetch=savedFetch;db.close();}
});
test("conversation sales handles only the new website cohort and suppresses repeated inbound text",async()=>{
 process.env.SALES_ENABLED="true";process.env.SALES_CONVERSATION_ENABLED="true";process.env.SALES_TEST_MODE="false";process.env.SALES_REPLY_DEBOUNCE_SECONDS="0";
 const cohort=new Date(Date.now()-3600000).toISOString();process.env.SALES_LEAD_COHORT_START=cohort;
 const db=new DatabaseSync(":memory:");db.exec(`CREATE TABLE leads(
  id INTEGER PRIMARY KEY, submitted_at TEXT, received_at TEXT, first_touch_sent_at TEXT, replied_at TEXT,
  followup_sent_at TEXT, duplicate_suppressed_at TEXT, name TEXT, phone TEXT, pickup TEXT, dropoff TEXT,
  bike_type TEXT, bike_make TEXT, bike_model TEXT, urgency TEXT, estimated_price TEXT
 )`);
 const before=new Date(Date.parse(cohort)-1000).toISOString(),after=new Date(Date.parse(cohort)+1000).toISOString();
 const insert=db.prepare("INSERT INTO leads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
 insert.run(1,before,before,null,null,null,null,"Old","760000001","Durban","Johannesburg","Standard","BMW","F800GS","7-10 Days","2500");
 insert.run(2,after,after,null,null,null,null,"New","760000002","Durban","Johannesburg","Standard","BMW","F800GS","7-10 Days","2500");
 const cards=[],payloads=[];const customerClient={info:{wid:{user:"27720000000"}},sendMessage:async()=>({id:{_serialized:"sent"}})};
 const approvalClient={info:{},sendMessage:async(_to,text)=>{cards.push(text);return {id:{_serialized:`card-${cards.length}`}};}};
 const norm=x=>String(x||"").replace(/\D/g,"");const local=x=>{const n=norm(x);return n.startsWith("27")?n.slice(2):n;};
 const agent=installSalesAgent({db,customerClient,approvalClient,approvalGroupId:"123@g.us",reasonerUrl:"https://example.invalid",token:"test",normalizePhone:norm,localPhone:local,logEvent:()=>{}});
 const savedFetch=global.fetch;global.fetch=async(_url,opts)=>{payloads.push(JSON.parse(opts.body));return {ok:true,json:async()=>({action:"reply",proposedReply:"What dates are you working with?",category:"availability",confidence:1,notes:""})};};
 const stamp=Math.floor(Date.now()/1000);
 try {
  assert.equal(await agent.onCustomer({fromMe:false,body:"Still interested",id:{_serialized:"false_old_cohort"},timestamp:stamp},db.prepare("SELECT * FROM leads WHERE id=1").get(),"760000001"),false);
  await agent.onCustomer({fromMe:false,body:"Still interested",id:{_serialized:"false_new_cohort_1"},timestamp:stamp},db.prepare("SELECT * FROM leads WHERE id=2").get(),"760000002");
  await agent.onCustomer({fromMe:false,body:"Still interested",id:{_serialized:"false_new_cohort_2"},timestamp:stamp},db.prepare("SELECT * FROM leads WHERE id=2").get(),"760000002");
	  await agent.processInboundConversations();
  assert.equal(payloads.length,1);assert.equal(cards.length,1);assert.match(cards[0],/New/);
 } finally {global.fetch=savedFetch;db.close();}
});
test("consecutive client messages create one approval for the whole sales turn",async()=>{
 process.env.SALES_ENABLED="true";process.env.SALES_CONVERSATION_ENABLED="true";process.env.SALES_TEST_MODE="false";process.env.SALES_REPLY_DEBOUNCE_SECONDS="0";
 process.env.SALES_LEAD_COHORT_START=new Date(Date.now()-3600000).toISOString();
 const db=new DatabaseSync(":memory:");db.exec(`CREATE TABLE leads(
  id INTEGER PRIMARY KEY, submitted_at TEXT, received_at TEXT, first_touch_sent_at TEXT, replied_at TEXT,
  followup_sent_at TEXT, duplicate_suppressed_at TEXT, name TEXT, phone TEXT, pickup TEXT, dropoff TEXT,
  bike_type TEXT, bike_make TEXT, bike_model TEXT, urgency TEXT, estimated_price TEXT
 )`);
 const received=new Date().toISOString();
 db.prepare("INSERT INTO leads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(1,received,received,null,null,null,null,"Antoun","760000000","Johannesburg","Cape Town","Standard","BMW","R 1250 GS","December","2800");
 const cards=[],payloads=[];
 const customerClient={info:{wid:{user:"27720000000"}},sendMessage:async()=>({id:{_serialized:"sent"}})};
 const approvalClient={info:{},sendMessage:async(_to,text)=>{cards.push(text);return {id:{_serialized:`card-${cards.length}`}};}};
 const norm=x=>String(x||"").replace(/\D/g,"");const local=x=>{const n=norm(x);return n.startsWith("27")?n.slice(2):n;};
 const agent=installSalesAgent({db,customerClient,approvalClient,approvalGroupId:"123@g.us",reasonerUrl:"https://example.invalid",token:"test",normalizePhone:norm,localPhone:local,logEvent:()=>{}});
 const savedFetch=global.fetch;global.fetch=async(_url,opts)=>{const p=JSON.parse(opts.body);payloads.push(p);return {ok:true,json:async()=>({action:"owner_input",salesMove:"close",proposedReply:"",ownerQuestion:"What return rate should I offer for the January leg?",category:"price",confidence:1,notes:"Two-leg quote needs approval"})};};
 const stamp=Math.floor(Date.now()/1000);
 try {
  await agent.onCustomer({fromMe:false,body:"I need it in Cape Town by 8 December",id:{_serialized:"false_leg_1"},timestamp:stamp},db.prepare("SELECT * FROM leads WHERE id=1").get(),"760000000");
  await agent.onCustomer({fromMe:false,body:"Then I need it back to Joburg late January",id:{_serialized:"false_leg_2"},timestamp:stamp},db.prepare("SELECT * FROM leads WHERE id=1").get(),"760000000");
  assert.equal(cards.length,0);
  assert.equal(await agent.processInboundConversations(),1);
  assert.equal(payloads.length,1);assert.equal(payloads[0].newMessages.length,2);
  assert.match(payloads[0].message,/8 December[\s\S]*late January/);
  assert.equal(cards.length,1);assert.match(cards[0],/Client \(2 messages\)/);
  assert.match(cards[0],/I need from you/);assert.match(cards[0],/return rate/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sales_approvals").get().n,1);
 } finally {global.fetch=savedFetch;db.close();}
});
test("Day 3 and Day 7 website follow-ups require approval and do not duplicate",async()=>{
 process.env.SALES_ENABLED="true";process.env.SALES_CONVERSATION_ENABLED="true";process.env.SALES_TEST_MODE="false";
 const cohort=new Date(Date.now()-10*86400000).toISOString();process.env.SALES_LEAD_COHORT_START=cohort;
 const db=new DatabaseSync(":memory:");db.exec(`CREATE TABLE leads(
  id INTEGER PRIMARY KEY, submitted_at TEXT, received_at TEXT, first_touch_sent_at TEXT, replied_at TEXT,
  followup_sent_at TEXT, duplicate_suppressed_at TEXT, name TEXT, phone TEXT, pickup TEXT, dropoff TEXT,
  bike_type TEXT, bike_make TEXT, bike_model TEXT, urgency TEXT, estimated_price TEXT
 )`);
 const first=new Date(Date.now()-8*86400000).toISOString(),followup=new Date(Date.now()-7*86400000).toISOString(),received=new Date(Date.now()-9*86400000).toISOString();
 db.prepare("INSERT INTO leads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(1,received,received,first,null,followup,null,"Sipho","760000000","Durban","Johannesburg","Standard","Yamaha","Tenere 700","7-10 Days","2500");
 const cards=[];let customerSent=0;
 const customerClient={info:{wid:{user:"27720000000",_serialized:"27720000000@c.us"}},sendMessage:async()=>{customerSent++;return {id:{_serialized:`sent-${customerSent}`}};}};
 const approvalClient={info:{},sendMessage:async(_to,text)=>{cards.push(text);return {id:{_serialized:`card-${cards.length}`}};}};
 const norm=x=>String(x||"").replace(/\D/g,"");const local=x=>{const n=norm(x);return n.startsWith("27")?n.slice(2):n;};
 const agent=installSalesAgent({db,customerClient,approvalClient,approvalGroupId:"123@g.us",reasonerUrl:"https://example.invalid",token:"test",normalizePhone:norm,localPhone:local,logEvent:()=>{}});
 const savedFetch=global.fetch;global.fetch=async(url,opts)=>{const p=JSON.parse(opts.body);return {ok:true,json:async()=>url.endsWith("/sales/sequence")?{action:"reply",proposedReply:p.stage==="day3"?"Are you still looking to move the Tenere?":"No problem, reach out when you're ready.",category:"other",confidence:1,notes:""}:{intent:"send",finalReply:p.proposedReply,response:""}};};
 try {
  assert.equal(await agent.processLeadSequence(),1);assert.match(cards[0],/Day 3 website-lead check-in/);assert.equal(customerSent,0);
  const day3=db.prepare("SELECT a.* FROM sales_approvals a JOIN sales_lead_sequence s ON s.id=a.sequence_id WHERE s.stage='day3'").get();
  await agent.onApproval({from:"123@g.us",author:"27720000000@c.us",_viaSharedBridge:true,fromMe:false,hasQuotedMsg:true,getQuotedMessage:async()=>({id:{_serialized:day3.group_message_id},body:cards[0]}),id:{_serialized:"false_send_day3"},body:"send it",timestamp:Math.floor(Date.now()/1000)});
  assert.equal(customerSent,1);assert.equal(db.prepare("SELECT state FROM sales_lead_sequence WHERE stage='day3'").get().state,"sent");
  assert.equal(await agent.processLeadSequence(),1);assert.match(cards.at(-1),/Day 7 website-lead close/);
  assert.equal(await agent.processLeadSequence(),0);assert.equal(db.prepare("SELECT COUNT(*) n FROM sales_lead_sequence").get().n,2);
 } finally {global.fetch=savedFetch;db.close();}
});
