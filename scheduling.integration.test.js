// Full scheduling process, with real in-memory SQLite and mocked network/WhatsApp only.
const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{EventEmitter}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const routes={};let sent=[],network=[],sheetRows=[];const app={use(){},get:(p,...h)=>routes['GET '+p]=h,post:(p,...h)=>routes['POST '+p]=h,listen(){}};
const express=()=>app;express.json=()=>()=>{};
class Client extends EventEmitter{constructor(){super();this.info={wid:{user:'27000000000'}}}initialize(){return Promise.resolve()}sendMessage(group,text){sent.push({group,text});return Promise.resolve({id:{_serialized:'fake-'+sent.length}})}}
const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const env={INTAKE_API_KEY:'test-access-key',SHADOW_MODE:'false',WHATSAPP_OUTBOUND_ENABLED:'true',SCHEDULING_GROUP_ID:'12345@g.us',BTSA_DATA_DIR:require('node:path').resolve('work-test-state'),GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON:JSON.stringify({client_email:'test@example.invalid',private_key:pair.privateKey.export({type:'pkcs8',format:'pem'}),project_id:'test'})};
const row=Array(40).fill('');row[0]='511';row[1]='Pending';row[4]='JHB to EL';row[5]='Example customer';row[15]='Example bike';row[37]='0123456789abcdef';sheetRows=[row];
async function fetchMock(url,options={}){network.push(String(url));if(String(url).includes('oauth2'))return {ok:true,json:async()=>({access_token:'test-token'})};if(String(url).includes('/gviz/'))return {ok:true,text:async()=>Array(40).fill('Header').join(',')+'\n'+sheetRows.map(r=>r.join(',')).join('\n')};if(String(url).includes('sheets.googleapis.com')){if(String(url).includes(':append')){sheetRows.push(JSON.parse(options.body).values[0]);return {ok:true,json:async()=>({})};}if(String(url).includes('values:batchUpdate')){for(const item of JSON.parse(options.body).data){const m=item.range.match(/!([A-Z]+)(\d+)/);let n=0;for(const c of m[1])n=n*26+c.charCodeAt(0)-64;sheetRows[Number(m[2])-2][n-1]=item.values[0][0];}return {ok:true,json:async()=>({})};}if(options.method==='PUT'){const m=decodeURIComponent(url).match(/!B(\d+)/);const v=JSON.parse(options.body).values[0];sheetRows[Number(m[1])-2][1]=v[0];sheetRows[Number(m[1])-2][2]=v[1];}return {ok:true,json:async()=>({values:structuredClone(sheetRows)})};}throw Error('Unexpected network destination '+url);}
const sqlite=[];const context=vm.createContext({console,Buffer,URLSearchParams,AbortSignal,Date,Intl,Map,Set,crypto,fetch:fetchMock,process:{env},setInterval(){},setTimeout(){},__dirname:process.cwd(),require:name=>{if(name==='express')return express;if(name==='whatsapp-web.js')return {Client,LocalAuth:class{},MessageMedia:class{}};if(name==='node:sqlite')return {DatabaseSync:class{constructor(){const db=new DatabaseSync(':memory:');sqlite.push(db);return db}}};return require(name)}});
vm.runInContext(fs.readFileSync('scheduling.js','utf8'),context);
async function call(method,path,body={},params={}){let result,status=200;const req={body,params,get:name=>name==='x-api-key'?'test-access-key':''};const res={set(){return this},status(n){status=n;return this},json(v){result=v;return this}};const handlers=routes[method+' '+path];assert.ok(handlers,path);for(let i=0;i<handlers.length;i++){let next=false;await handlers[i](req,res,()=>next=true);if(i<handlers.length-1&&!next)break;}return {status,result};}
(async()=>{
 assert.equal(vm.runInContext("canApproveInGroup({from:'12345@g.us'})",context),false);
 vm.runInContext("APPROVAL_AUTHORS.add('*')",context);
 assert.equal(vm.runInContext("canApproveInGroup({from:'12345@g.us',author:'678@lid'})",context),true);
 assert.equal(vm.runInContext("canApproveInGroup({from:'999@g.us',author:'678@lid'})",context),false);
 vm.runInContext("APPROVAL_AUTHORS.clear()",context);
 await new Promise(r=>setImmediate(r));let response=await call('GET','/dispatch/workspace');assert.equal(response.status,200);assert.ok(response.result.orders.find(o=>o.externalId==='SLA-511'));
 response=await call('POST','/dispatch/manual',{requestKey:'dashboard-test-create',order:{clientName:'Example manual',bike:'Test bike',route:'DBN to JHB',collection:{date:'2026-11-08',time:'',confidence:'confirmed',precision:'day'}}});assert.equal(response.status,200);assert.equal(response.result.syncState,'synced');const manual=response.result;assert.equal(sheetRows.filter(r=>r[39]===manual.externalId).length,1);
 const again=await call('POST','/dispatch/manual',{requestKey:'dashboard-test-create',order:{clientName:'Example manual',bike:'Test bike',route:'DBN to JHB',collection:{date:'2026-11-08',time:'',confidence:'confirmed',precision:'day'}}});assert.equal(again.result.externalId,manual.externalId);assert.equal(sheetRows.filter(r=>r[39]===manual.externalId).length,1);
 response=await call('POST','/dispatch/order/:ref',{version:manual.version,changes:{collectionAddress:'Example street',status:'Collected'}},{ref:manual.externalId});assert.equal(response.status,200);assert.equal(response.result.syncState,'synced');assert.equal(sheetRows.find(r=>r[39]===manual.externalId)[22],'Example street');
 await call('POST','/dispatch/ingest',{messageId:'query-whatsapp-1',text:'SLA511 delivered?',timestamp:1794124800});assert.equal(sheetRows[0][1],'Pending');
 response=await call('POST','/dispatch/ingest',{messageId:'test-whatsapp-1',text:'SLA511 delivered',timestamp:1794124800});assert.equal(response.status,200);assert.equal(sheetRows[0][1],'Delivered');const messageCount=sent.length;
 await call('POST','/dispatch/ingest',{messageId:'test-whatsapp-1',text:'SLA511 delivered',timestamp:1794124800});assert.equal(sent.length,messageCount);
 const booking='*New Order - DBN to JHB - R2500*\n\nMake and Model: Honda Cbr';
 const honda=Array(40).fill('');honda[0]='526';honda[1]='Pending';honda[4]='DBN to JHB';honda[5]='Example customer';honda[7]='27000000001';honda[15]='Honda';honda[16]='CBR';honda[37]='1123456789abcdef';sheetRows.push(honda);const marked=[...honda];marked[0]='525';marked[1]='Duplicate';marked[37]='3123456789abcdef';sheetRows.push(marked);
 await call('GET','/dispatch/workspace');
 const proof={text:'Collected',quotedText:booking,quotedMessageId:'original-booking',mediaData:'dGVzdA==',mediaType:'image/jpeg'};
 const album={...proof,mediaData:undefined,messageId:'collection-album',albumPhotos:Array.from({length:5},(_,i)=>({type:'image/jpeg',data:Buffer.from([255,216,255,i]).toString('base64')}))};
 response=await call('POST','/dispatch/ingest',{...album,albumPhotos:undefined,albumError:'Album incomplete'});assert.equal(response.status,200);assert.equal(honda[1],'Pending');
 response=await call('POST','/dispatch/ingest',album);assert.equal(response.status,200);assert.equal(honda[1],'Collected');
 await call('POST','/dispatch/ingest',album);
 const collection=await call('GET','/dispatch/order/:ref',{}, {ref:'SLA-526'});assert.equal(collection.result.proofs.length,5);assert.equal(collection.result.messages.filter(m=>m.kind==='Collected').length,1);

 const duplicate=[...honda];duplicate[0]='527';duplicate[1]='Pending';duplicate[37]='2123456789abcdef';sheetRows.push(duplicate);
 await call('GET','/dispatch/workspace');
 response=await call('POST','/dispatch/ingest',{...proof,messageId:'ambiguous-quote'});assert.equal(response.status,200);assert.equal(duplicate[1],'Pending');
 const photoUpload={stage:'delivery',photos:[{type:'image/jpeg',data:'/9j/AQ=='},{type:'image/jpeg',data:'/9j/Ag=='}]};
 response=await call('POST','/dispatch/order/:ref/photos',photoUpload,{ref:'SLA-511'});assert.equal(response.status,200);assert.equal(response.result.proofs.length,2);
 response=await call('POST','/dispatch/order/:ref/photos',photoUpload,{ref:'SLA-511'});assert.equal(response.result.proofs.length,2);
 const record=await call('GET','/dispatch/order/:ref',{}, {ref:'SLA-511'});assert.equal(record.result.order.status,'Delivered');assert.ok(record.result.events.length);assert.equal(record.result.messages[0].state,'awaiting_approval');assert.equal(sent.every(m=>m.group==='12345@g.us'),true);
 console.log('PASS: complete scheduler boot and authenticated routes, manual create/read/edit, exact sheet-column writeback, idempotent retries, WhatsApp-to-sheet-to-dashboard completion, deduplicated acknowledgement, timeline and held client message. All network and WhatsApp mocked.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{for(const db of sqlite)db.close()});
