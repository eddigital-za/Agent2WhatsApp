"use strict";
const key=x=>{const value=typeof x==="string"?x:x?.id||x?._serialized||"";return value.match(/^(?:true|false)_\d+@g\.us_([^_]+)/)?.[1]||value;};
const stage=s=>/^(collected|delivered)(?:\s+(?:today|yesterday))?[.!]?$/i.test(String(s||"").trim());

function createAlbumCollector({send,legacy,timeout=25000}) {
 const pending=new Map(),recent=new Set();
 async function finish(id){
  const a=pending.get(id);if(!a)return;pending.delete(id);clearTimeout(a.timer);
  recent.add(id);if(recent.size>500)recent.delete(recent.values().next().value);
  const children=[...a.children.values()],anchor=children.find(p=>stage(p.text))||(stage(a.parent?.text)?a.parent:null);
  if(!anchor){for(const p of children)await legacy(p);return;}
  const quote=[anchor,a.parent,...children].filter(p=>p?.quotedText);
  const distinct=new Set(quote.map(p=>p.quotedMessageId||p.quotedText));
  const captions=new Set(children.filter(p=>stage(p.text)).map(p=>p.text.trim().toLowerCase()));
  const photos=children.filter(p=>p.mediaData).map(p=>({type:p.mediaType,data:p.mediaData}));
  const valid=a.count>=2&&a.count<=12&&a.count===children.length&&photos.length===children.length&&photos.reduce((n,p)=>n+p.data.length,0)<=18000000;
  const context=quote[0];
  await send({from:anchor.from,author:anchor.author,messageId:id,text:anchor.text,timestamp:anchor.timestamp,
   hasMedia:true,quotedText:context?.quotedText,quotedMessageId:context?.quotedMessageId,
   ...(valid&&distinct.size===1&&captions.size<=1?{albumPhotos:photos}:{albumError:!valid?"Not all WhatsApp album photos were downloaded. The order was not updated.":"The album did not identify one booking and one update. The order was not updated."})});
 }
 function accept(payload,{parentId,count,isParent}){
  if(!parentId)return false;
  if(recent.has(parentId))return true;
  let a=pending.get(parentId);
  if(!a){if(pending.size>=40)return false;a={children:new Map(),count:0,author:payload.author,timer:setTimeout(()=>finish(parentId).catch(e=>console.error("Orders album forwarding failed:",e.message)),timeout)};pending.set(parentId,a);}
  if(a.author!==payload.author)return false;
  if(isParent){a.parent=payload;a.count=Number(count)||0;}
  else a.children.set(payload.messageId,payload);
  if(a.count&&a.children.size>=a.count)finish(parentId).catch(e=>console.error("Orders album forwarding failed:",e.message));
  return true;
 }
 return {accept};
}

function albumContext(message){
 const raw=message._data||{};
 if(message.type==="album")return {isParent:true,parentId:key(message.id),count:Number(raw.expectedImageCount||0)+Number(raw.expectedVideoCount||0)};
 const parent=raw.parentMsgKey||raw.parentMsgId;
 return {isParent:false,parentId:message.type==="image"&&parent&&(raw.associationType==="MEDIA_ALBUM"||!raw.associationType)?key(parent):""};
}
module.exports={createAlbumCollector,albumContext};
