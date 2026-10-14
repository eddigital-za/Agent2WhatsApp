const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { parseRoutes, forwardRoute } = require('./group-routing');
(async () => {
assert.deepEqual(parseRoutes(''), {});
for (const input of ['[]','null','{"bad":{"url":"https://example.com"}}','{"123@g.us":{"url":"http://example.com"}}','{"123@g.us":{"url":"https://user:pass@example.com"}}']) assert.throws(()=>parseRoutes(input));
const routes=parseRoutes('{"123@g.us":{"url":"https://example.com/inbound","secretEnv":"HANDOFF_SECRET"}}');
const payload={from:'123@g.us',messageId:'test-id',text:'test',quotedText:'original',mediaData:'fixture'};
let calls=0;
await forwardRoute(routes['123@g.us'],payload,{HANDOFF_SECRET:'test-only-secret'},async(url,options)=>{
calls++; assert.equal(url,'https://example.com/inbound'); assert.deepEqual(JSON.parse(options.body),payload);
assert.equal(options.headers['x-btsa-signature'],crypto.createHmac('sha256','test-only-secret').update(options.body).digest('hex'));
assert.equal(options.redirect,'error'); return {ok:true};
});
assert.equal(calls,1);
await assert.rejects(()=>forwardRoute(routes['123@g.us'],payload,{},async()=>{throw Error('must not call');}),/missing/);
calls=0;
await assert.rejects(()=>forwardRoute({url:'https://example.com'},payload,{},async()=>{calls++;return {ok:false,status:503};}),/503/);
assert.equal(calls,1);
assert.equal(routes['456@g.us'],undefined);
console.log('PASS: route validation, payload preservation, signing, one delivery, missing-secret rejection, no automatic retries, unknown-group isolation');
})().catch(e=>{console.error(e);process.exitCode=1;});
