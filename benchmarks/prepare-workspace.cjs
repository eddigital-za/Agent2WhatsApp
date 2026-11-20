'use strict';
// Offline only: no server startup, database access, credentials, or network calls.
const {buildRuns,region}=require('../dispatch-runs');
function prepare(workspace,today){
 if(!workspace||!Array.isArray(workspace.orders))throw Error('Expected a Dispatch workspace export with orders');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(today))throw Error('Expected YYYY-MM-DD planning date');
 const orders=workspace.orders;
 const refs=orders.map(o=>o.externalId);
 if(refs.some(r=>typeof r!=='string'||!r)||new Set(refs).size!==refs.length)throw Error('Missing or duplicate booking references');
 const plan=buildRuns(orders,today);
 const ids=new Map(plan.coverage.map((c,i)=>[c.id,'order-'+(i+1)]));
 const members=new Map(plan.runs.filter(r=>!r.alternative).flatMap(r=>r.members).map(m=>[m.id,m]));
 const candidates=[],coverage=[];
 for(const c of plan.coverage){
  const m=members.get(c.id),id=ids.get(c.id);
  if(!m){coverage.push({id,state:c.state,reason:'Requires review before solver inclusion'});continue;}
  const from=region(m.from),to=region(m.to);
  if(!from||!to){coverage.push({id,state:'review',reason:'Geographic location unresolved'});continue;}
  const conditional=Boolean(m.assignmentRequired||m.partner);
  candidates.push({id,from,to,bikes:m.load.bikes,cars:m.load.cars,
   pickupDate:m.pickup||null,deliveryDate:m.delivery||null,
   pickupTime:m.pickupTime||null,deliveryTime:m.deliveryTime||null,
   conditional,partnerHandover:Boolean(m.partner),
   deadline:m.deadline||null});
  coverage.push({id,state:conditional?'conditional':'candidate'});
 }
 if(coverage.length!==plan.tripCount||new Set(coverage.map(c=>c.id)).size!==plan.tripCount)throw Error('Incomplete trip accounting');
 return {schema:1,today,horizonDays:14,scope:'Offline candidate export. No coordinates, road matrix or driver-rest verification.',
  bookingCount:plan.bookingCount,tripCount:plan.tripCount,candidates,coverage};
}
module.exports={prepare};
if(require.main===module){
 const fs=require('node:fs');
 const [input,today]=process.argv.slice(2);
 if(!input||!today)throw Error('Usage: node benchmarks/prepare-workspace.cjs PRIVATE-workspace.json YYYY-MM-DD');
 process.stdout.write(JSON.stringify(prepare(JSON.parse(fs.readFileSync(input,'utf8')),today),null,2)+'\n');
}
