"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),fs=require("node:fs");
test("sheet check verifies the phone column, normalizes SA numbers and fails closed",async()=>{
 const text=fs.readFileSync(__dirname+"/order-intake.js","utf8");
 const start=text.indexOf("app.post('/sales/booking-status'");
 const end=text.indexOf("app.post('/inbound'",start);
 let handler,rows=[["","","","","","","","Phone"],["","","","","","","","0721234567"]],requests=0;
 const token="a".repeat(32);
 vm.runInNewContext(text.slice(start,end),{app:{post:(_p,h)=>handler=h},process:{env:{SALES_AGENT_TOKEN:token}},HISTORY_WEBHOOK_URL:"https://example.invalid",AbortSignal,console:{error(){}},fetch:async()=>{requests++;return {ok:true,json:async()=>({values:rows})};}});
 const run=async(phone,auth=token)=>{let result,status=200;await handler({body:{phone},get:()=>"Bearer "+auth},{status:n=>{status=n;return {json:v=>result=v}},json:v=>result=v});return {status,result};};
 assert.equal((await run("27721234567")).result.submitted,true);
 assert.equal((await run("27769999999")).result.submitted,false);
 rows=[["unexpected header"]];assert.equal((await run("27721234567")).status,503);
 const before=requests;assert.equal((await run("27721234567","wrong")).status,401);assert.equal(requests,before);
});
