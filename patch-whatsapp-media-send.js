"use strict";
const fs=require("node:fs");
const file=require.resolve("whatsapp-web.js/src/util/Injected/Utils");
const original=fs.readFileSync(file,"utf8");
const anchor="        // Bot's won't reply if canonicalUrl is set (linking)";
if(!original.includes("delete message.__x_id;")){
  if(!original.includes(anchor)||!original.includes("...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),"))throw Error("Unexpected WhatsApp media send source");
  fs.writeFileSync(file,original.replace(anchor,"        if (mediaOptions && Object.keys(mediaOptions).length) {\n            delete message.__x_id;\n            message.id = newMsgKey;\n        }\n"+anchor));
}
