'use strict';
const assert=require('node:assert/strict');
const {buildRuns,mapLinks}=require('./dispatch-runs');
const {planAhead}=require('./dispatch-planning');
const eta=date=>({date,confidence:'confirmed',precision:'day'});
function booking(n,extra={}){return {externalId:'SLA-'+n,bike:'Honda CBR',clientName:'John Test',route:'DBN to JHB',status:'New Order',contractor:'BTSA',quantity:1,collection:eta('2026-11-20'),delivery:eta('2026-11-21'),collectionAddress:'Woodhaven Durban '+n,deliveryAddress:'Sandton Johannesburg '+n,syncState:'synced',...extra};}
function plan(orders){return planAhead(orders,[],'2026-11-19T08:00:00Z');}
let result=plan(Array.from({length:9},(_,i)=>booking(i))).execution;
assert.equal(result.runs.length,1);assert.equal(result.runs[0].bikes,9);assert.equal(result.runs[0].trailer,'Hire 6m trailer');
assert.match(result.runs[0].sequence[0].address,/Woodhaven/);assert.match(result.runs[0].sequence.at(-1).address,/Pomona/);
let lastPickup=result.runs[0].sequence.map(s=>s.kind).lastIndexOf('Pickup');
assert.ok(lastPickup<result.runs[0].sequence.findIndex(s=>s.kind==='Drop-off'));
result=plan(Array.from({length:13},(_,i)=>booking(i))).execution;
assert.equal(result.runs.length,2);assert.equal(new Set(result.runs.flatMap(r=>r.jobs)).size,13);assert.ok(result.runs.every(r=>r.bikes<=11));
result=plan([booking(1,{bike:'VW Beetle'}),...Array.from({length:5},(_,i)=>booking(i+2))]).execution;
assert.ok(result.runs.some(r=>r.cars===1&&r.bikes<=3));assert.equal(result.runs.reduce((n,r)=>n+r.bikes,0),5);
result=plan([booking(1),booking(2,{route:'JHB to DBN',collection:eta('2026-11-22'),delivery:eta('2026-11-23')})]).execution;
assert.equal(result.runs[0].returnIndex,1);assert.equal(result.runs[1].outboundIndex,0);
result=plan([booking(1),booking(2,{route:'JHB to DBN',collection:eta('2026-11-21'),delivery:eta('2026-11-22')})]).execution;
assert.equal(result.runs[0].returnIndex,undefined);
result=plan([booking(1,{contractor:'BTSA, Cheetah Express'}),booking(2,{quantity:0}),booking(3,{bike:'TVS Tuk Tuk'}),booking(4,{collection:{...eta('2026-11-20'),confidence:'expected'}})]).execution;
assert.equal(result.runs.length,0);assert.equal(result.blocked.length,3);
const stops=Array.from({length:15},(_,i)=>({address:'Address '+i}));
const maps=mapLinks(stops);assert.equal(maps.length,4);
for(const map of maps){const u=new URL(map.url);assert.equal(u.hostname,'www.google.com');assert.ok((u.searchParams.get('waypoints')||'').split('|').length<=3);}
assert.equal(new URL(maps[0].url).searchParams.get('destination'),new URL(maps[1].url).searchParams.get('origin'));
const first=plan([booking(1)]).jobs[0];
assert.equal(planAhead([booking(1,{quantity:2})],[{id:first.id,signature:first.signature,state:'planned'}],'2026-11-19T08:00:00Z').jobs[0].changed,true);
assert.equal(planAhead([booking(1)],[{id:first.id,signature:first.signature,state:'planned'}],'2026-11-19T08:00:00Z').execution.runs.length,1);
console.log('PASS: trailer escalation, load splitting, car limits, return pairing, timing boundaries, partner exclusions, quantity validation, Maps segments and stale plan detection. Fake bookings only.');
