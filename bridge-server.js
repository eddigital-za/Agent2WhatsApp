"use strict";
const {auth,request} = require("./shared-transport");
function installBridge(app,client,MessageMedia) {
  let routes = new Map();
  let pendingOwners = [];
  let directOwner=null; let controllerOwner=null; let controllers=[];
  const recent=new Map();
  app.get("/bridge/status",auth,(_req,res)=>{
    const account=String(client.info?.wid?.user||"");
    res.json({whatsappReady:Boolean(client.info),accountPrefix:account.slice(0,4),routeCount:routes.size,
      directInboundConfigured:Boolean(directOwner),controllerInboundConfigured:Boolean(controllerOwner),routes:[...routes.entries()].map(([group,url])=>({group,destination:new URL(url).hostname})),pendingOwners});
  });
  app.get("/bridge/groups",auth,async(_req,res)=>{
    try {
      if(!client.info)return res.status(503).json({error:"Session not ready"});
      const chats=await client.getChats();
      res.json(chats.filter(x=>x.isGroup).map(x=>({id:x.id._serialized,name:x.name})));
    }catch(e){res.status(500).json({error:e.message});}
  });
  async function refresh() {
    const services=[...new Set([...JSON.parse(process.env.SHARED_BRIDGE_WORKERS||"[]"), process.env.SALES_AGENT_WORKER_URL].filter(Boolean))];
    const next=new Map(), pending=[];
    let nextDirect=null,nextController=null,nextControllers=[];
    for(const url of services){
      const parsed=new URL(url);
      if(parsed.protocol!=="https:"||parsed.username||parsed.password)throw new Error("Invalid worker URL");
      const config=await request(url,"/bridge/config");
      if(config.active&&config.directInbound)nextDirect=url;
      if(config.active&&config.controllers?.length){nextController=url;nextControllers=config.controllers;}
      for(const group of config.groups||[]){
        if(!/^\d+@g\.us$/.test(group))throw new Error("Invalid worker group");
        if(!config.active){pending.push({group,destination:parsed.hostname});continue;}
        if(next.has(group))throw new Error("Conflicting group owners; routing unchanged");
        next.set(group,url);
      }
    }
    routes=next;pendingOwners=pending;directOwner=nextDirect;controllerOwner=nextController;controllers=nextControllers;
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
  client.on("ready", () => {
    refresh()
      .then(result => console.log("Shared bridge routes refreshed", result))
      .catch(error => console.error("Shared bridge route refresh failed:", error.message));
  });
  return {
    hasRoute:group=>routes.has(group)||(!String(group).endsWith("@g.us")&&Boolean(controllers.includes(group)?controllerOwner:directOwner)),
    pending:group=>pendingOwners.some(x=>x.group===group),
    async forward(group,payload){
      const url=routes.get(group)||(!String(group).endsWith("@g.us")?(controllers.includes(group)?controllerOwner:directOwner):null);if(!url)return false;
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

async function serializeMessage(message,downloadMedia,client) {
  const id=message.id||{};
  const messageId=id._serialized||id.$1||(id.fromMe!==undefined&&id.remote&&id.id?String(id.fromMe)+"_"+id.remote+"_"+id.id:"");
  if(!messageId)throw new Error("Inbound message ID unavailable");
  if(!id._serialized)id._serialized=messageId;
  const raw=message._data||{};
  const payload={from:message.from,phone:message.from.replace("@c.us",""),author:message.author||message.from,
    text:message.body||"",messageId,timestamp:message.timestamp,type:message.type,hasMedia:Boolean(message.hasMedia),
    mediaType:null,mediaFilename:null,mediaData:null,mediaUrl:null,media:null,
    quotedText:raw.quotedMsg?.body||raw.quotedMsg?.caption||null,
    quotedMessageId:raw.quotedStanzaID||null,quotedAuthor:null,quotedFrom:null};
  if(!String(message.from).endsWith("@g.us")){
    try{const contact=await message.getContact();payload.phone=contact?.number||payload.phone;}catch(_){}
    if(String(message.from).endsWith("@lid")&&client?.getContactLidAndPhone){try{const ids=await client.getContactLidAndPhone([message.from]);if(ids?.[0]?.pn)payload.phone=ids[0].pn.replace("@c.us","");}catch(_){}}
  }
  if(message.hasQuotedMsg){
    try{
      const q=await message.getQuotedMessage();
      payload.quotedText=q?.body||payload.quotedText;
      payload.quotedMessageId=q?.id?._serialized||payload.quotedMessageId;
      payload.quotedAuthor=q?.author||null;payload.quotedFrom=q?.from||null;
    }catch(e){console.warn("Quote unavailable; retained event context");}
  }
  if(message.hasMedia){
    const media=await downloadMedia(message);
    if(!media?.data)throw new Error("Inbound media unavailable");
    payload.mediaData=media.data;payload.mediaType=media.mimetype;payload.mediaFilename=media.filename||null;
    payload.media={data:media.data,mimetype:media.mimetype,filename:media.filename||null};
  }
  return payload;
}

module.exports={installBridge,serializeMessage};
