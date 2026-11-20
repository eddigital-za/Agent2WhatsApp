'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const {planAhead,planningBrief}=require('./dispatch-planning');
const {createOperations}=require('./dispatch-operations');
const now='2026-11-19T08:00:00Z';
const eta=(date,time='')=>({date,time,confidence:'confirmed',precision:time?'minute':'day'});
const job=(ref,extra={})=>({externalId:ref,bike:'Honda '+ref,clientName:'JOHN Test',route:'JHB to DBN',status:'New Order',contractor:'BTSA',collection:eta('2026-11-20'),delivery:eta('2026-11-21'),collectionAddress:'Pickup '+ref,deliveryAddress:'Drop '+ref,syncState:'synced',...extra});
const orders=[
 job('SLA-1'),
 job('SLA-2',{route:'Johannesburg to Durban',legs:[{handoverAt:'2026-11-21T08:00',to:'Depot A',status:'Planned'}]}),
 job('SLA-3',{contractor:'Cheetah Express'}),
 job('SLA-4',{contractor:'BTSA, Cheetah Express'}),
 job('SLA-5',{collection:eta('2026-11-22')}),
 job('SLA-6',{collection:eta('2026-11-20'),delivery:null}),
 job('SLA-7',{collection:{...eta('2026-11-20'),confidence:'expected'}}),
 job('SLA-8',{status:'Delivered',returnTrip:{status:'Pending',contractor:'BTSA',collection:eta('2026-11-23'),delivery:eta('2026-11-24'),legs:[],collectionAddress:'Return pickup',deliveryAddress:'Return drop'}}),
 job('SLA-9',{status:'Cancelled'}),
 job('SLA-10',{collection:null,delivery:null}),
 job('SLA-11',{collection:eta('2026-12-10'),delivery:eta('2026-12-11')})
];
let plan=planAhead(orders,[],now);
assert.equal(plan.suggestions.length,1);
assert.deepEqual(plan.suggestions[0].jobs,['SLA-1:1','SLA-2:1']);
assert.equal(plan.jobs.find(j=>j.ref==='SLA-8').trip,2);
assert.equal(plan.jobs.find(j=>j.ref==='SLA-8').route,'DBN → JHB');
assert.equal(plan.jobs.filter(j=>['SLA-9','SLA-11'].includes(j.ref)).length,0);
assert.ok(plan.jobs.find(j=>j.ref==='SLA-4').reasons.includes('Confirm partner handover date'));
assert.ok(plan.jobs.find(j=>j.ref==='SLA-10').reasons.includes('Pickup date needed'));
assert.equal(plan.jobs.find(j=>j.ref==='SLA-10').stops.length,0);
for(const ref of ['SLA-1','SLA-2']){
 const stops=plan.suggestions[0].sequence.filter(stop=>stop.ref===ref);
 assert.equal(stops[0].kind,'Pickup');
 assert.equal(stops.at(-1).kind,'Drop-off');
}
assert.ok(plan.suggestions[0].sequence.some(stop=>stop.kind==='Handover'));
const saved=plan.jobs.find(j=>j.id==='SLA-1:1');
const decisions=[{id:saved.id,signature:saved.signature,state:'planned'}];
assert.equal(planAhead(orders,decisions,now).jobs.find(j=>j.id===saved.id).acknowledged,true);
assert.equal(planAhead(orders,decisions,now).suggestions.length,0);
const changed=orders.map(j=>j.externalId==='SLA-1'?{...j,delivery:eta('2026-11-22')}:j);
assert.equal(planAhead(changed,decisions,now).jobs.find(j=>j.id===saved.id).changed,true);
assert.equal(planAhead(orders,[{...decisions[0],state:'snoozed',until_day:'2026-11-20'}],now).jobs.find(j=>j.id===saved.id).acknowledged,true);
assert.equal(planAhead(orders,[{...decisions[0],state:'snoozed',until_day:'2026-11-19'}],now).jobs.find(j=>j.id===saved.id).acknowledged,false);
const cancelled=orders.map(j=>j.externalId==='SLA-1'?{...j,status:'Cancelled'}:j);
assert.equal(planAhead(cancelled,decisions,now).jobs.find(j=>j.id===saved.id).changed,true);
assert.match(planningBrief(plan),/BTSA TRIP IDEAS/);
assert.match(planningBrief(plan),/NEXT 14 DAYS/);
assert.equal(planningBrief({...plan,execution:{journeys:[]}}),'');
assert.equal(planAhead([job('W',{collection:{...eta('2026-11-20'),window:'afternoon'},delivery:{...eta('2026-11-20'),window:'morning'}})],[],now).jobs[0].reasons.some(reason=>reason.includes('is before pickup')),true);
assert.equal(planAhead([job('X',{delivery:eta('2026-11-19')})],[],now).suggestions.length,0);

(async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(fs.readFileSync('scheduling.js','utf8').match(/db\.exec\(`([\s\S]*?)`\);/)[1]);
 const rows=[];
 const ops=createOperations({db,now:()=>now,sheet:{read:async()=>structuredClone(rows),append:async row=>rows.push(row),update:async()=>{},updateCells:async()=>{}}});
 const order=await ops.createAndSync({bike:'Test bike',clientName:'John Test',route:'JHB to DBN',contractor:'BTSA',collection:eta('2026-11-20'),delivery:eta('2026-11-21')},'planning-safe-test');
 let current=ops.planning().jobs.find(j=>j.ref===order.externalId);
 const routes={};
 ops.install({get:(path,...handlers)=>routes[path]=handlers.at(-1),post:(path,...handlers)=>routes[path]=handlers.at(-1)},()=>{});
 let result;
 const res={set(){},json(value){result=value},status(code){this.code=code;return this}};
 await routes['/dispatch/plan']({body:{id:current.id,signature:current.signature,state:'planned'}},res);
 assert.equal(result.jobs[0].acknowledged,true);
 await ops.refresh();
 assert.equal(ops.planning().jobs[0].acknowledged,true);
 ops.update(order.externalId,{delivery:eta('2026-11-22')},order.version);
 assert.equal(ops.planning().jobs[0].changed,true);
 assert.throws(()=>ops.decidePlan(current.id,current.signature,'planned'),/changed/);
 current=ops.planning().jobs[0];
 ops.decidePlan(current.id,current.signature,'snoozed');
 assert.equal(ops.planning().jobs[0].decision,'snoozed');
 const prior=rows.length;
 await routes['/dispatch/workspace']({query:{recorded:'1'}},res);
 assert.ok(result.planning);
 assert.equal(rows.length,prior);

 const second=await ops.createAndSync({bike:'Honda CBR',clientName:'Jane Test',route:'DBN to JHB',contractor:'BTSA'},'run-plan-safe-test');
 const proposed=ops.planning().execution.journeys.find(j=>j.source.some(s=>s.id===second.externalId+':1'));
 assert.ok(proposed);
 const baseline=JSON.stringify(ops.get(second.externalId));
 const messageCount=db.prepare('SELECT COUNT(*) n FROM dispatch_messages').get().n;
 await routes['/dispatch/run-plan']({body:{id:proposed.id,signature:proposed.signature}},res);
 assert.equal(result.execution.accepted.length,1);
 assert.equal(JSON.stringify(ops.get(second.externalId)),baseline);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM dispatch_messages').get().n,messageCount);
 assert.equal(ops.planning().execution.accepted[0].id,proposed.id);
 assert.equal(ops.keepRun(proposed.id,proposed.signature).execution.accepted.length,1);
 ops.update(second.externalId,{bike:'Yamaha XT'},ops.get(second.externalId).version);
 assert.equal(ops.planning().execution.accepted[0].changed,true);
 assert.throws(()=>ops.keepRun(proposed.id,'wrong',true),/changed/);
 ops.keepRun(proposed.id,proposed.signature,true);
 assert.equal(ops.planning().execution.accepted.length,0);
 assert.throws(()=>ops.keepRun(proposed.id,proposed.signature),/changed/);

 db.close();
 const db2=new DatabaseSync(':memory:');
 db2.exec(fs.readFileSync('scheduling.js','utf8').match(/db\.exec\(`([\s\S]*?)`\);/)[1]);
 const sheetRows=[];
 const trips=createOperations({db:db2,now:()=>now,sheet:{read:async()=>structuredClone(sheetRows),append:async row=>sheetRows.push(row),update:async()=>{},updateCells:async()=>{}}});
 const enter=(key,route,bike='Honda CBR')=>trips.createAndSync({bike,clientName:'Test Customer',route,contractor:'BTSA',collection:eta('2026-11-24'),delivery:eta('2026-11-25')},key);
 await enter('circuit-outbound','DBN to JHB');
 await enter('circuit-homebound','JHB to DBN');
 const savedCircuit=trips.planning().execution.journeys[0];
 trips.keepRun(savedCircuit.id,savedCircuit.signature);
 await enter('circuit-lowveld-car','JHB to Hoedspruit','BAJAJ Qute');
 await enter('circuit-lowveld-bike','Montana to Malelane');
 const extension=trips.planning().execution.journeys.find(j=>j.replaces?.includes(savedCircuit.id));
 assert.ok(extension);assert.equal(extension.source.length,4);
 assert.throws(()=>trips.keepRun(extension.id,'stale'),/changed/);
 assert.equal(db2.prepare('SELECT COUNT(*) n FROM dispatch_run_plans').get().n,1);
 const beforeOrders=JSON.stringify(trips.all());
 trips.keepRun(extension.id,extension.signature);
 assert.equal(db2.prepare('SELECT COUNT(*) n FROM dispatch_run_plans').get().n,1);
 assert.equal(trips.planning().execution.accepted[0].source.length,4);
 assert.equal(JSON.stringify(trips.all()),beforeOrders);
 assert.equal(trips.planning().execution.bookingCount,4);
 assert.equal(trips.planning().execution.coverageCounts.saved,4);
 db2.close();

 console.log('PASS: planning, corridor/date grouping, stop precedence, partner limits, returns, no invented dates, durable actions, changed plans and authenticated route handlers. Fake bookings only.');
})().catch(error=>{console.error(error);process.exitCode=1;});

