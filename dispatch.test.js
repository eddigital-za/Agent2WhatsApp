// Runs only dispatch handlers with a fake sheet: no SQLite, WhatsApp or real orders.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('scheduling.js','utf8');
const routes={};let rows=[],writes=0,verifyBad=false;
const context=vm.createContext({process:{env:{}},Buffer,URLSearchParams,crypto:require('node:crypto'),console,
  auth(){},SHEET_CONTRACTORS:['BTSA'],app:{post:(url,...handlers)=>routes[url]=handlers.at(-1)},
  fetch:async(url,options)=>{
    if(options.method==='PUT'){writes++;const values=JSON.parse(options.body).values[0];rows[0][1]=values[0];rows[0][2]=values[1];return {ok:true,json:async()=>({})};}
    const values=url.includes('B2')?[[rows[0][1],...(rows[0][2]?[rows[0][2]]:[])]]:rows;
    return {ok:true,json:async()=>({values:verifyBad?[['wrong']]:values})};
  }});
vm.runInContext(source.slice(source.indexOf('const DISPATCH_SHEET_ID'),source.indexOf("app.get('/sync-status'")),context);
vm.runInContext("dispatchToken=async()=> 'test-token'",context);
async function update(body){let status=200,result;await routes['/dispatch/update']({body},{status(n){status=n;return this},json(value){result=value}});return {status,result};}
function row(id='999999'){const r=Array(40).fill('');r[0]=id;r[1]='Pending';r[2]='BTSA';return r;}
const valid={externalId:'SLA-999999',status:'In Transit',contractors:['BTSA','Moto Movers'],expected:{status:'Pending',contractor:'BTSA'}};
(async()=>{
 rows=[row()];let r=await update(valid);assert.equal(r.status,200);assert.equal(r.result.contractor,'BTSA, Moto Movers');assert.equal(writes,1);
 rows=[row()];r=await update({...valid,contractors:[]});assert.equal(r.status,200);assert.equal(r.result.contractor,'');
 rows=[row()];const before=writes;r=await update({...valid,expected:{status:'New Order',contractor:'BTSA'}});assert.equal(r.status,409);assert.equal(writes,before);
 rows=[row(),row()];assert.equal((await update(valid)).status,409);
 rows=[row()];rows[0][39]='M-0001';assert.equal((await update(valid)).status,409);
 assert.equal((await update({...valid,externalId:'M-0001'})).status,200);
 rows=[row()];assert.equal((await update({...valid,status:'invalid'})).status,400);
 verifyBad=true;assert.equal((await update(valid)).status,409);verifyBad=false;
 rows=[row()];context.fetch=async(url,options)=>{if(options.method==='PUT'){writes++;verifyBad=true;}return {ok:true,json:async()=>({values:verifyBad?[['wrong']]:rows})}};
 assert.equal((await update(valid)).status,502);
 const html=fs.readFileSync('dispatch.html','utf8');new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
 console.log('PASS: verified saves, multiple contractors, clearing assignments, stale conflicts, duplicate/manual references, validation, failed read-back, dashboard syntax. No real services used.');
})().catch(e=>{console.error(e);process.exitCode=1;});
