"use strict";
const {hkdfSync,createHmac,createDecipheriv,timingSafeEqual}=require("node:crypto");
const max=6*1024*1024;

function decryptPhoto(data,key) {
  const secret=Buffer.isBuffer(key)||Array.isArray(key)?Buffer.from(key):Buffer.from(String(key||"").replace(/^data:;base64,/,""),"base64");
  if(secret.length!==32||data.length<26||data.length>max||(data.length-10)%16)throw Error("Invalid encrypted photo");
  const keys=Buffer.from(hkdfSync("sha256",secret,Buffer.alloc(32),"WhatsApp Image Keys",112));
  const iv=keys.subarray(0,16), encrypted=data.subarray(0,-10);
  const tag=createHmac("sha256",keys.subarray(48,80)).update(iv).update(encrypted).digest().subarray(0,10);
  if(!timingSafeEqual(tag,data.subarray(-10)))throw Error("WhatsApp photo failed authentication");
  const cipher=createDecipheriv("aes-256-cbc",keys.subarray(16,48),iv);
  return Buffer.concat([cipher.update(encrypted),cipher.final()]);
}

async function downloadPhoto(raw) {
  if(!raw?.mediaKey)throw Error("WhatsApp photo media key unavailable");
  const mime=String(raw.mimetype||"image/jpeg").split(";")[0];
  if(!/^image\/(jpeg|png|webp|heic|gif)$/.test(mime))throw Error("Unsupported WhatsApp photo type");
  const urls=[raw.directPath,raw.clientUrl,raw.deprecatedMms3Url].filter(v=>typeof v==="string"&&v&&!v.includes("\\")).flatMap(v=>{try{return [new URL(v,"https://mmg.whatsapp.net")];}catch{return [];}});
  const url=urls.find(u=>u.protocol==="https:"&&!u.username&&!u.password&&!u.port&&/^mmg(?:-[a-z0-9-]+)?\.whatsapp\.net$/.test(u.hostname)&&/^\/(?:o\d+\/)?(?:v\/|d\/f\/|mms\/image\/)/.test(u.pathname));
  if(!url)throw Error("WhatsApp photo CDN location unavailable");
  const response=await fetch(url,{headers:{Origin:"https://web.whatsapp.com"},redirect:"error",signal:AbortSignal.timeout(15000)});
  if(!response.ok||!response.body)throw Error("WhatsApp photo download HTTP "+response.status);
  const parts=[];let length=0;
  for await(const chunk of response.body){length+=chunk.length;if(length>max)throw Error("WhatsApp photo exceeds size limit");parts.push(chunk);}
  return {data:decryptPhoto(Buffer.concat(parts),raw.mediaKey).toString("base64"),mimetype:mime,filename:raw.filename||null};
}

module.exports={downloadPhoto,decryptPhoto};
