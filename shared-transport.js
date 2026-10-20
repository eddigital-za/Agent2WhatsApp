"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

function authorized(req) {
  const expected = process.env.SHARED_BRIDGE_TOKEN || "";
  const supplied = String(req.get("authorization") || "").replace(/^Bearer /, "");
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length >= 32 && a.length === b.length && crypto.timingSafeEqual(a,b);
}
function auth(req,res,next) {
  if (!authorized(req)) return res.status(401).json({error:"Unauthorized"});
  next();
}
function groups() {
  return [...new Set([
    process.env.SCHEDULING_GROUP_ID || process.env.ORDERS_GROUP_ID || "",
    process.env.ALLOWED_GROUP_ID || "",
    ...String(process.env.EXTRA_ALLOWED_GROUP_IDS || "").split(","),
  ].map(s=>s.trim()).filter(s=>/^\d+@g\.us$/.test(s)))];
}
async function request(base, route, body) {
  const response = await fetch(base.replace(/\/$/,"")+route,{
    method:body===undefined?"GET":"POST",redirect:"error",
    headers:{"Content-Type":"application/json",authorization:"Bearer "+process.env.SHARED_BRIDGE_TOKEN},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
    signal:AbortSignal.timeout(45000),
  });
  if(!response.ok) throw new Error("Shared bridge HTTP "+response.status);
  return response.json();
}
class SharedClient extends EventEmitter {
  constructor(base){super();this.base=base;this.info={sharedTransport:true};}
  async initialize(){
    const status=await request(this.base,"/bridge/status");
    this.bridgeReady=Boolean(status.whatsappReady);
    if(this.bridgeReady)this.emit("ready");
    else console.error("Shared bridge WhatsApp session is not ready");
  }
  async sendMessage(chatId,message,options={}){
    const body=typeof message==="string"?{chatId,text:message}:{chatId,media:message,options};
    return request(this.base,"/bridge/send",body);
  }
  async getChats(){return (await request(this.base,"/bridge/groups")).map(g=>({isGroup:true,id:{_serialized:g.id},name:g.name}));}
  async destroy(){}
}
function installIngress(app,client,options={}) {
  const stateFile=path.join("/app/.wwebjs_auth","shared-inbound-ids.json");
  let completed=new Set();
  try {completed=new Set(JSON.parse(fs.readFileSync(stateFile,"utf8")));}catch(e){if(e.code!=="ENOENT")throw e;}
  const active=new Set();
  function persist(){
    fs.mkdirSync(path.dirname(stateFile),{recursive:true});
    const tmp=stateFile+".tmp";
    fs.writeFileSync(tmp,JSON.stringify([...completed].slice(-5000)),{mode:0o600});
    fs.renameSync(tmp,stateFile);
  }
  app.get("/bridge/config",auth,(_req,res)=>res.json({
    active:Boolean(process.env.SHARED_BRIDGE_URL),groups:options.groups?options.groups():groups(),directInbound:Boolean(options.directInbound),controllers:options.controllers||[],sharedTransport:Boolean(process.env.SHARED_BRIDGE_URL),accountPrefix:String(client.info?.wid?.user||"").slice(0,4)
  }));
  app.post("/bridge/inbound",auth,async(req,res)=>{
    if(!process.env.SHARED_BRIDGE_URL)return res.status(409).json({error:"Shared mode disabled"});
    const p=req.body||{};
    if((!(options.groups?options.groups():groups()).includes(p.from)&&!(options.directInbound&&!String(p.from).endsWith("@g.us"))&&!(options.controllers||[]).includes(p.from))||!p.messageId||typeof p.text!=="string")return res.status(400).json({error:"Invalid inbound message"});
    if(completed.has(p.messageId)||active.has(p.messageId))return res.json({deduplicated:true});
    active.add(p.messageId);
    try {
      const message={
        from:p.from,author:p.author,body:p.text,fromMe:false,
        _viaSharedBridge:true,
        id:{_serialized:p.messageId},timestamp:p.timestamp,type:p.type,
        hasMedia:Boolean(p.hasMedia),hasQuotedMsg:Boolean(p.quotedMessageId||p.quotedText),
        _data:{},
        getContact:async()=>({number:p.phone||""}),
        downloadMedia:async()=>p.mediaData?{data:p.mediaData,mimetype:p.mediaType,filename:p.mediaFilename}:null,
        getQuotedMessage:async()=>({body:p.quotedText||"",id:{_serialized:p.quotedMessageId||""},author:p.quotedAuthor||"",from:p.quotedFrom||""}),
        reply:async(text)=>client.sendMessage(p.from,text),
      };
      const handlers=client.listeners("message");
      if(!handlers.length)throw new Error("Inbound handler missing");
      for(const handler of handlers)await handler(message);
      completed.add(p.messageId);persist();
      res.json({success:true});
    }catch(e){console.error("Shared inbound failed:",e.message);res.status(500).json({error:"Inbound failed; reconcile before retry"});}
    finally{active.delete(p.messageId);}
  });
}
module.exports={auth,authorized,groups,request,SharedClient,installIngress};
