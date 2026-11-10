"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {resolveDirectRecipient}=require("./bridge-server");

test("direct customer sends resolve to a WhatsApp LID before dispatch",async()=>{
  const client={getContactLidAndPhone:async ids=>[{pn:ids[0],lid:"987654321@lid"}]};
  assert.equal(await resolveDirectRecipient(client,"27720000000@c.us"),"987654321@lid");
  assert.equal(await resolveDirectRecipient(client,"120363000000@g.us"),"120363000000@g.us");
});

test("direct customer sends fail closed when no LID is available",async()=>{
  const client={getContactLidAndPhone:async()=>[{}]};
  await assert.rejects(resolveDirectRecipient(client,"27720000000@c.us"),/LID unavailable/);
});
