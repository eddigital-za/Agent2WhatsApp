"use strict";
const {auth,request} = require("./shared-transport");
function installBridge(app,client,MessageMedia) {
  let routes = new Map();
  let pendingOwners = [];
  const recent=new Map();
  app.get("/bridge/status",auth,(_req,res)=>{
    const account=String(client.info?.wid?.user||"");
    res.json({whatsappReady:Boolean(client.info),accountPrefix:account.slice(0,4),routeCount:routes.size,
      routes:[...routes.entries()].map(([group,url])=>({group,destination:new URL(url).hostname})),pendingOwners});
  });
  app.get("/bridge/groups",auth,async(_req,res)=>{
    try {
      if(!client.info)return res.status(503).json({error:"Session not ready"});
      const chats=await client.getChats();
      res.json(chats.filter(x=>x.isGroup).map(x=>({id:x.id._serialized,name:x.name})));
    }catch(e){res.status(500).json({error:e.message});}
  });
  async function refresh() {
    const services=JSON.parse(process.env.SHARED_BRIDGE_WORKERS||"[]");
    const next=new Map(), pending=[];
    for(const url of services){
      const parsed=new URL(url);
      if(parsed.protocol!=="https:"||parsed.username||parsed.password)throw new Error("Invalid worker URL");
      const config=await request(url,"/bridge/config");
      for(const group of config.groups||[]){
        if(!/^\d+@g\.us$/.test(group))throw new Error("Invalid worker group");
        if(!config.active){pending.push({group,destination:parsed.hostname});continue;}
        if(next.has(group))throw new Error("Conflicting group owners; routing unchanged");
        next.set(group,url);
      }
    }
    routes=next;pendingOwners=pending;
    return {routeCount:routes.size,pendingOwners};
  }
  app.post("/bridge/refresh",auth,async(_req,res)=>{
    try{res.json(await refresh());}catch(e){res.status(409).json({error:e.message});}
  });
  app.post("/bridge/send",auth,async(req,res)=>{
    try{
      if(!client.info)return res.status(503).json({error:"WhatsApp not ready"});
      const {chatId,text,media,options}=req.body||{};
      const configured=new Set([process.env.ALLOWED_GROUP_ID,process.env.ORDER_INTAKE_GROUP_ID,
        ...String(process.env.EXTRA_ALLOWED_GROUP_IDS||"").split(","),...routes.keys(),
        ...pendingOwners.map(x=>x.group)].filter(Boolean));
      if(typeof chatId!=="string"||(!configured.has(chatId)&&chatId!==process.env.ALLOWED_DIRECT_ID&&!/^\d{7,15}@c\.us$/.test(chatId)))
        return res.status(403).json({error:"Chat is not configured"});
      if(!text&&!media?.data)return res.status(400).json({error:"Message required"});
      if(media&&(!media.mimetype||typeof media.data!=="string"))return res.status(400).json({error:"Invalid media"});
      const message=media?new MessageMedia(media.mimetype,media.data,media.filename):text;
      const sent=await client.sendMessage(chatId,message,options||{});
      res.json({success:true,id:{_serialized:sent?.id?._serialized||""}});
    }catch(e){console.error("Shared outbound failed:",e.message);res.status(500).json({error:"Send outcome requires reconciliation"});}
  });
  return {
    hasRoute:group=>routes.has(group),
    pending:group=>pendingOwners.some(x=>x.group===group),
    async forward(group,payload){
      const url=routes.get(group);if(!url)return false;
      const id=payload.messageId;
      if(!id)throw new Error("Message ID required for routed delivery");
      if(recent.has(id))return true;
      recent.set(id,"in-flight");
      if(recent.size>5000)recent.delete(recent.keys().next().value);
      // Preserve uncertain outcomes instead of automatically retrying side effects.
      await request(url,"/bridge/inbound",payload);
      recent.set(id,"delivered");
      return true;
    }
  };
}
module.exports={installBridge};
