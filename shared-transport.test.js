const assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm");
function load(file,overrides={}){
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(__dirname+"/"+file,"utf8"),{
 module,exports:module.exports,require:n=>overrides[n]||require(n),process,Buffer,URL,AbortSignal,console,
 fetch:overrides.fetch||(()=>{throw Error("External requests forbidden in tests")})
 },{filename:file});return module.exports;
}
(async()=>{
process.env.SHARED_BRIDGE_TOKEN="test-secret-at-least-32-characters-long";
process.env.ALLOWED_GROUP_ID="123@g.us";
process.env.SHARED_BRIDGE_URL="https://bridge.example";
const disk={readFileSync:()=>{const e=Error();e.code="ENOENT";throw e;},mkdirSync(){},writeFileSync(){},renameSync(){}};
const transport=load("shared-transport.js",{"node:fs":disk});
assert.equal(transport.authorized({get:()=>""}),false);
assert.equal(transport.authorized({get:()=>"Bearer "+process.env.SHARED_BRIDGE_TOKEN}),true);
const routes={};const app={get:(p,...h)=>routes[p]=h,post:(p,...h)=>routes[p]=h};
const client=new transport.SharedClient("https://bridge.example");
let count=0;
client.on("message",async m=>{count++;assert.equal(m.body,"test");assert.equal((await m.getQuotedMessage()).body,"quoted");assert.equal((await m.downloadMedia()).data,"data");});
transport.installIngress(app,client);
const result={code:200,status(n){this.code=n;return this;},json(p){this.body=p;return this;}};
const p={from:"123@g.us",messageId:"once",text:"test",mediaData:"data",quotedText:"quoted"};
await routes["/bridge/inbound"].at(-1)({body:p},result);
await routes["/bridge/inbound"].at(-1)({body:p},result);
assert.equal(count,1);assert.equal(result.body.deduplicated,true);
await routes["/bridge/inbound"].at(-1)({body:{...p,from:"999@g.us"}},result);assert.equal(result.code,400);
let active=false;
const server=load("bridge-server.js",{"./shared-transport":{auth:transport.auth,request:async(base,path,body)=>{
 if(path==="/bridge/config")return {groups:["456@g.us"],active};
 assert.equal(path,"/bridge/inbound");return {success:true};
}}});
process.env.SHARED_BRIDGE_WORKERS='["https://social.example"]';
const endpoints={};const sent=[];
const bridge=server.installBridge({get:(p,...h)=>endpoints[p]=h,post:(p,...h)=>endpoints[p]=h},
{info:{wid:{user:"27670000000"}},sendMessage:async(...args)=>{sent.push(args);return {id:{_serialized:"sent"}};}},class{});
await endpoints["/bridge/refresh"].at(-1)({},result);
assert.equal(bridge.pending("456@g.us"),true);assert.equal(bridge.hasRoute("456@g.us"),false);
active=true;await endpoints["/bridge/refresh"].at(-1)({},result);
assert.equal(bridge.hasRoute("456@g.us"),true);assert.equal(bridge.pending("456@g.us"),false);
await endpoints["/bridge/send"].at(-1)({body:{chatId:"999@g.us",text:"test"}},result);assert.equal(result.code,403);assert.equal(sent.length,0);
await endpoints["/bridge/send"].at(-1)({body:{chatId:"456@g.us",text:"test"}},result);assert.equal(sent.length,1);assert.equal(result.body.id._serialized,"sent");
await endpoints["/bridge/status"].at(-1)({},result);assert.equal(result.body.accountPrefix,"2767");
console.log("PASS: authenticated ingress, duplicate suppression, quoted/media preservation, wrong-group rejection, legacy ownership, route activation, outbound allowlist, message IDs and masked account identity");
})().catch(e=>{console.error(e);process.exitCode=1;});
