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
 const message={from:"123@g.us",author:"owner@lid",_viaSharedBridge:true,_approvalAuthorPhone:"27720000000",id:{_serialized:"false_approval1"},body:"send it",fromMe:false};
 try {
  await agent.onApproval({...message,_viaSharedBridge:false});
  await agent.onApproval({...message,fromMe:true});
  await agent.onApproval({...message,_approvalAuthorPhone:"27670000000"});
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
