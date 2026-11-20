'use strict';
const assert=require('node:assert/strict');
const {buildRuns,mapLinks}=require('./dispatch-runs');
const eta=date=>({date,confidence:'confirmed',precision:'day'});
const today='2026-11-20';
const order=(n,extra={})=>({externalId:'SLA-'+n,bike:'Honda CBR',clientName:'Test Customer',route:'DBN to JHB',status:'New Order',contractor:'BTSA',collection:null,delivery:null,syncState:'synced',collectionAddress:'Durban, South Africa',deliveryAddress:'Johannesburg, South Africa',...extra});
const plan=(orders,kept=[])=>buildRuns(orders,today,[],kept);
function check(p){
 assert.equal(Object.values(p.coverageCounts).reduce((a,b)=>a+b,0),p.tripCount);
 for(const j of p.journeys){
  assert.equal(j.route[0],'Durban');assert.equal(j.route.at(-1),'Durban');
  assert.equal(new Set(j.source.map(s=>s.id)).size,j.source.length);
  assert.ok(j.reasons.length);assert.ok(Number.isFinite(j.score));
  assert.ok(j.metrics.changedOrders<=j.source.length);
  for(const leg of j.legs){assert.ok(leg.cars<=1);assert.ok(leg.bikes<=(leg.cars?3:11));}
  for(let i=1;i<j.legs.length;i++)assert.ok(j.legs[i].date>=j.legs[i-1].end);
 }
}
let p=plan([order(1,{collection:eta('2026-11-24'),delivery:eta('2026-11-26')}),order(2),order(3,{route:'JHB to DBN'})]);
check(p);assert.ok(p.journeys.some(j=>j.source.length===3));
const before=JSON.stringify([order(1)]);
plan([order(1)]);assert.equal(JSON.stringify([order(1)]),before);
const lowveld=[order(1,{collection:eta('2026-11-24'),delivery:eta('2026-11-25')}),order(2,{route:'JHB to DBN',collection:eta('2026-11-24'),delivery:eta('2026-11-25')}),order(3,{bike:'BAJAJ Qute',route:'JHB to Hoedspruit',collection:eta('2026-11-24'),delivery:eta('2026-11-25')}),order(4,{route:'Montana to Malelane',collection:eta('2026-11-24'),delivery:eta('2026-11-25')})];
p=plan(lowveld);check(p);
const complete=p.journeys.find(j=>j.source.length===4);assert.ok(complete);
assert.ok(complete.route.includes('Hoedspruit')&&complete.route.includes('Malelane'));
assert.ok(complete.dateChanges.length);
const saved=plan(lowveld.slice(0,2)).journeys[0];
assert.ok(plan(lowveld,[saved]).journeys.some(j=>j.replaces?.includes(saved.id)&&j.source.length===4));
// A different destination produces an onward/return circuit without any named-route rule.
p=plan([order(1),order(2,{route:'JHB to Bloemfontein'}),order(3,{route:'Bloemfontein to DBN'})]);check(p);
assert.ok(p.journeys.some(j=>j.source.length===3&&j.route.includes('Bloemfontein')));
// Even one Cape-bound shared booking plus return work is evaluated automatically.
// Direct BTSA and the original partner handover are competing variants, not duplicate jobs.
const cape=[order(1,{route:'DBN to CPT',contractor:'BTSA, Cheetah Express',deliveryAddress:'Cape Town'}),order(2,{route:'CPT to DBN',collectionAddress:'Cape Town',deliveryAddress:'Durban'})];
p=plan(cape);check(p);
assert.ok(p.journeys.some(j=>j.route.includes('Cape Town')&&j.legs.some(l=>l.directVariant)));
assert.ok(p.journeys.some(j=>j.legs.some(l=>l.to==='Johannesburg'&&l.members.some(m=>m.id==='SLA-1:1'))));
assert.ok(p.journeys.length>=2);
// New orders trigger fresh options, without a destination or trailer being entered.
const starting=plan([order(1)]);
const grown=plan([order(1),...cape.map((o,i)=>({...o,externalId:'SLA-'+(i+20)}))]);check(grown);
assert.ok(grown.journeys.some(j=>j.route.includes('Cape Town')));
assert.notDeepEqual(grown.journeys.map(j=>j.id),starting.journeys.map(j=>j.id));
// Partner and unassigned work are conditional and must never be presented as confirmed BTSA work.
p=plan([order(1,{contractor:'Cheetah Express'}),order(2,{contractor:''})]);check(p);
assert.equal(p.partners.length,1);assert.equal(p.opportunities.length,1);
assert.ok(p.journeys.every(j=>j.assignmentRequired.length===j.source.length));
p=plan([order(1,{status:'Delivered',returnTrip:{status:'New Order',contractor:'BTSA'}})]);check(p);
assert.ok(p.journeys.some(j=>j.source.some(s=>s.id==='SLA-1:2')));
assert.ok(p.journeys.every(j=>!j.source.some(s=>s.id==='SLA-1:1')));
p=plan(Array.from({length:13},(_,i)=>order(i)));check(p);
assert.equal(p.runs.length,2);assert.equal(new Set(p.runs.flatMap(r=>r.jobs)).size,13);
const thirteen=[...lowveld,order(5,{contractor:''}),order(6,{contractor:'Cheetah Express'}),order(7,{status:'In Transit'}),order(8,{collection:eta('2026-11-19')}),order(9,{bike:'Tuk Tuk'}),order(10,{syncState:'conflict'}),order(11,{collection:eta('2026-12-20')}),order(12,{route:'JHB to Herolds Bay'}),order(13,{status:'Paused'})];
p=plan(thirteen);check(p);assert.equal(p.bookingCount,13);assert.equal(p.coverage.length,13);
assert.equal(p.coverage.find(r=>r.id==='SLA-6:1').state,'partner');
assert.equal(p.coverage.find(r=>r.id==='SLA-11:1').state,'later');
assert.ok(p.coverage.every(r=>r.state==='proposed'||r.state==='saved'||r.reason));
const stops=Array.from({length:15},(_,i)=>({address:'Address '+i}));
const maps=mapLinks(stops);assert.equal(maps.length,4);
for(const link of maps){const url=new URL(link.url);assert.equal(url.hostname,'www.google.com');assert.ok((url.searchParams.get('waypoints')||'').split('|').length<=3);}
assert.equal(new URL(maps[0].url).searchParams.get('destination'),new URL(maps[1].url).searchParams.get('origin'));
console.log('PASS: general circuit search, automatic Cape options, direct vs partner variants, dynamic new orders, capacities, saved extensions, conditional assignments, date conflicts and complete order accounting. Fake bookings only.');
