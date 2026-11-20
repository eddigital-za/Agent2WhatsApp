'use strict';
const assert=require('node:assert/strict');
const {buildRuns,mapLinks,region}=require('./dispatch-runs');
const eta=(date,confidence='confirmed')=>({date,confidence,precision:'day'});
const now='2026-11-20';
function order(n,extra={}){return {externalId:'SLA-'+n,bike:'Honda CBR',clientName:'John Test',route:'DBN to JHB',status:'New Order',contractor:'BTSA',collection:null,delivery:null,syncState:'synced',collectionAddress:'Woodhaven Durban',deliveryAddress:'Sandton Johannesburg',...extra};}
function plan(orders,kept=[]){return buildRuns(orders,now,[],kept);}
let p=plan([order(1,{collection:eta('2026-11-24'),delivery:eta('2026-11-26')}),order(2),order(3,{route:'JHB to DBN'})]);
assert.equal(p.journeys.length,1);assert.equal(p.journeys[0].legs.length,2);
assert.equal(p.journeys[0].legs[0].bikes,2);assert.equal(p.journeys[0].legs[0].date,'2026-11-24');
assert.equal(p.journeys[0].legs[1].bikes,1);assert.ok(p.journeys[0].legs[1].date>p.journeys[0].legs[0].end);
assert.equal(p.journeys[0].legs[0].members.find(i=>i.id==='SLA-2:1').condition,'Suggested dates');
assert.equal(p.journeys[0].legs[0].spare,3);
let mixed=Array.from({length:5},(_,i)=>order(i,{route:'Ballito-Paarl (Pearl valley)',contractor:'BTSA, Cheetah Express',deliveryAddress:'Paarl Cape Town'}));
p=plan(mixed);
assert.equal(p.journeys.length,2);assert.ok(p.journeys.some(j=>j.alternative&&j.route.at(-1)==='Cape Town'));
const normal=p.journeys.find(j=>!j.alternative);
assert.equal(normal.legs[0].to,'Johannesburg');assert.match(normal.legs[0].sequence.at(-1).address,/Pomona/);
assert.ok(normal.legs[0].members.every(m=>m.partner));
p=plan(mixed,[normal]);assert.equal(p.journeys.length,0);assert.equal(p.accepted.length,1);assert.equal(p.accepted[0].changed,false);
const changed=mixed.map((o,i)=>i===0?{...o,delivery:eta('2026-11-29')}:o);
assert.equal(plan(changed,[normal]).accepted[0].changed,true);
p=plan([order(1,{status:'Delivered',returnTrip:{status:'New Order',contractor:'BTSA'}})]);
assert.equal(p.runs.length,1);assert.equal(p.runs[0].from,'Johannesburg');assert.equal(p.runs[0].jobs[0],'SLA-1:2');
p=plan([order(1,{status:'In Transit'}),order(2,{contractor:'Cheetah Express'}),order(3,{contractor:''}),order(4,{syncState:'conflict'}),order(5,{collection:eta('2026-11-19')})]);
assert.equal(p.journeys.length,0);assert.equal(p.blocked.length,3);assert.equal(p.opportunities.length,1);
p=plan(Array.from({length:13},(_,i)=>order(i)));assert.equal(p.runs.length,2);assert.equal(new Set(p.runs.flatMap(r=>r.jobs)).size,13);assert.ok(p.runs.every(r=>r.bikes<=11));
p=plan([order(1,{bike:'VW Beetle'}),...Array.from({length:5},(_,i)=>order(i+2))]);
assert.equal(p.runs.length,2);assert.ok(p.runs.every(r=>r.cars<=1&&r.bikes<=(r.cars?3:11)));
p=plan([order(1,{collection:eta('2026-12-20')}),order(2,{collection:eta('2026-11-24')}),order(3,{collection:eta('2026-11-25')})]);
assert.equal(p.future.length,1);assert.equal(p.runs.length,2);
p=plan([order(1,{route:'DBN to JHB',collection:eta('2026-11-23'),delivery:eta('2026-11-25')}),order(2,{route:'JHB to CPT'}),order(3,{route:'CPT to DBN'})]);
assert.deepEqual(p.journeys[0].route,['Durban','Johannesburg','Cape Town','Durban']);
assert.ok(p.journeys[0].legs.every((r,i,legs)=>!i||r.date>legs[i-1].end));
p=plan([order(1,{route:'CPT to PTA',collection:eta('2026-11-27')}),order(2,{route:'CPT to PMB',collection:eta('2026-11-27')})]);
assert.equal(p.runs.length,2);assert.ok(p.runs.every(r=>r.from==='Cape Town'));
assert.equal(region('Pellissier'),'Bloemfontein');assert.equal(region('Montana'),'Johannesburg');
const stops=Array.from({length:15},(_,i)=>({address:'Address '+i}));
const maps=mapLinks(stops);assert.equal(maps.length,4);
for(const link of maps){const u=new URL(link.url);assert.equal(u.hostname,'www.google.com');assert.ok((u.searchParams.get('waypoints')||'').split('|').length<=3);}
assert.equal(new URL(maps[0].url).searchParams.get('destination'),new URL(maps[1].url).searchParams.get('origin'));

p=plan([order(1,{bike:'BAJAJ Qute',route:'JHB to Hoedspruit',collection:eta('2026-11-24')}),order(2,{route:'Montana to Malelane',collection:eta('2026-11-24')})]);
assert.equal(p.runs.length,1);assert.equal(p.runs[0].to,'Lowveld');assert.equal(p.runs[0].cars,1);assert.equal(p.runs[0].bikes,1);
assert.ok(p.journeys.every(j=>j.start<=p.end));
console.log('PASS: undated fill, mixed Pomona split, direct Cape alternative, three-leg circuits, independent returns, capacity splitting, commitment boundaries, saved plan changes and mobile Maps. Fake bookings only.');
