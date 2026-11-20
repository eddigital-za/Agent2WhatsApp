'use strict';
const crypto = require('node:crypto');
const {buildRuns}=require('./dispatch-runs');
const {localDay, closed, customerFirstName} = require('./dispatch-domain');

function addDays(day, count) {
 const date = new Date(day+'T00:00:00Z');
 date.setUTCDate(date.getUTCDate()+count);
 return date.toISOString().slice(0,10);
}
function routeParts(route) {
 return String(route||'').split(/\s+(?:to|→)\s+/i).map(part=>part.trim()).filter(Boolean);
}
function city(value) {
 const name=String(value||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
 return ({jhb:'johannesburg',joburg:'johannesburg',dbn:'durban',cpt:'cape town',pmb:'pietermaritzburg',el:'east london'})[name]||name;
}
function stopBounds(stop) {
 if(stop.time)return [stop.time,stop.time];
 const windows={morning:['06:00','11:59'],afternoon:['12:00','17:59'],evening:['18:00','23:59']};
 return windows[String(stop.window||'').toLowerCase()]||['00:00','23:59'];
}
function planAhead(orders, decisions=[], instant=new Date().toISOString(),kept=[]) {
 const today=localDay(instant), end=addDays(today,14), jobs=[];
 const saved=new Map(decisions.map(row=>[row.id,row]));
 for(const order of orders) {
  if(order.status==='Duplicate')continue;
  const trips=[{...order,trip:1}];
  if(order.returnTrip)trips.push({...order,...order.returnTrip,collection:order.returnTrip.collection||null,delivery:order.returnTrip.delivery||null,legs:order.returnTrip.legs||[],collectionAddress:order.returnTrip.collectionAddress||order.deliveryAddress,deliveryAddress:order.returnTrip.deliveryAddress||order.collectionAddress,route:routeParts(order.route).reverse().join(' → '),trip:2});
  for(const trip of trips) {
   const id=order.externalId+':'+trip.trip;
   const previous=saved.get(id);
   if(closed(trip.status)&&!(trip.status==='Cancelled'&&previous?.state==='planned'))continue;
   const carriers=String(trip.contractor||'').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
   const own=carriers.length===1&&carriers[0]==='BTSA';
   const mixed=carriers.includes('BTSA')&&!own;
   const collected=!!trip.actualCollection||['Collected','In Transit'].includes(trip.status);
   const stops=[];
   if(!collected&&trip.collection?.date)stops.push({kind:'Pickup',...trip.collection,address:trip.collectionAddress||routeParts(trip.route)[0]||''});
   for(const leg of trip.legs||[]) {
    if(!leg.handoverAt||['Handed over','Delivered','Cancelled'].includes(leg.status))continue;
    const [date,time='']=leg.handoverAt.split('T');
    stops.push({kind:'Handover',date,time,confidence:leg.handoverConfidence||'confirmed',address:leg.to||'Depot'});
   }
   if(trip.delivery?.date)stops.push({kind:'Drop-off',...trip.delivery,address:trip.deliveryAddress||routeParts(trip.route).at(-1)||''});
   const upcoming=stops.filter(stop=>stop.date>=today&&stop.date<=end);
   // Keep undated BTSA jobs visible as decisions without adding calendar stops.
   if(!upcoming.length&&!(own&&!stops.length)&&previous?.state!=='planned')continue;
   const reasons=[];
   if(!collected&&!trip.collection?.date)reasons.push('Pickup date needed');
   if(!trip.delivery?.date)reasons.push('Delivery date needed');
   if(stops.some(stop=>stop.confidence!=='confirmed'||stop.precision==='week'))reasons.push('Confirm estimated dates');
   for(let index=1;index<stops.length;index++){
    const stop=stops[index],before=stops[index-1];
    if(stop.date<before.date||stop.date===before.date&&stopBounds(stop)[1]<stopBounds(before)[0]){
     reasons.push(stop.kind+' '+stop.date+(stop.time?' '+stop.time:stop.window?' '+stop.window:'')+' is before '+before.kind.toLowerCase()+' '+before.date+(before.time?' '+before.time:before.window?' '+before.window:'')+'. Check these dates.');
    }
   }
   if(trip.syncState&&trip.syncState!=='synced')reasons.push('Resolve sheet sync');
   if(mixed)reasons.push(stops.some(stop=>stop.kind==='Handover'&&stop.confidence==='confirmed')?'Confirm which stops BTSA will handle':'Confirm partner handover date');
   if(!own&&!mixed)reasons.push('Partner schedule');
   if(trip.status==='Cancelled')reasons.push('Planned trip cancelled');
   const signature=crypto.createHash('sha256').update(JSON.stringify({syncState:trip.syncState,status:trip.status,contractor:trip.contractor,route:trip.route,bike:trip.bike,quantity:trip.quantity,stops,collectionContact:trip.collectionContact,deliveryContact:trip.deliveryContact})).digest('hex');
   const changed=previous?.state==='planned'&&previous.signature!==signature;
   const acknowledged=previous?.signature===signature&&(previous.state==='planned'||previous.state==='snoozed'&&previous.until_day>today);
   if(!upcoming.length&&stops.length&&!changed)continue;
   const label=[trip.bike,customerFirstName(trip)].filter(Boolean).join(' · ')+(trip.trip===2?' · Return':'');
   jobs.push({id,ref:order.externalId,trip:trip.trip,label,route:trip.route,carrier:trip.contractor||'Unassigned',bike:trip.bike,quantity:trip.quantity,own,mixed,stops,upcoming,reasons,signature,changed:!!changed,acknowledged:!!acknowledged,decision:acknowledged?previous.state:null});
  }
 }
 jobs.sort((a,b)=>Number(b.changed)-Number(a.changed)||Number(!!b.reasons.length)-Number(!!a.reasons.length)||(a.upcoming[0]?.date||end).localeCompare(b.upcoming[0]?.date||end)||a.label.localeCompare(b.label));
 const buckets=new Map();
 for(const job of jobs) {
  if(!job.own||job.acknowledged||job.reasons.length||job.stops[0]?.kind!=='Pickup')continue;
  const parts=routeParts(job.route);
  if(parts.length!==2||!parts.every(Boolean))continue;
  const pickup=job.stops[0];
  const key=pickup.date+'|'+job.stops.at(-1).date+'|'+parts.map(city).join('|');
  if(!buckets.has(key))buckets.set(key,[]);
  buckets.get(key).push(job);
 }
 const suggestions=[];
 for(const members of buckets.values()) {
  if(members.length<2)continue;
  // Choose the next dated stop whose earlier stop for that bike is finished.
  const pending=members.map(job=>({job,index:0}));
  const sequence=[];
  while(pending.some(item=>item.index<item.job.stops.length)) {
   const available=pending.filter(item=>item.index<item.job.stops.length).sort((a,b)=>{
    const x=a.job.stops[a.index],y=b.job.stops[b.index];
    return (x.date+' '+(x.time||stopBounds(x)[0])).localeCompare(y.date+' '+(y.time||stopBounds(y)[0]))||a.job.label.localeCompare(b.job.label);
   });
   const item=available[0],stop=item.job.stops[item.index++];
   sequence.push({...stop,label:item.job.label,ref:item.job.ref,trip:item.job.trip});
  }
  let earliest='';
  const chronological=sequence.every(stop=>{
   const [lower,upper]=stopBounds(stop);
   if(earliest>stop.date+upper)return false;
   if(stop.date+lower>earliest)earliest=stop.date+lower;
   return true;
  });
  if(!chronological)continue;
  suggestions.push({route:members[0].route,date:members[0].stops[0].date,jobs:members.map(job=>job.id),sequence});
 }
 return {today,end,jobs,suggestions,execution:buildRuns(orders,today,decisions,kept)};
}
function planningBrief(plan) {
 const proposals=plan.execution?.journeys||[];
 if(!proposals.length)return '';
 const lines=['','🗓 *BTSA TRIP IDEAS · NEXT 14 DAYS*'];
 for(const trip of proposals.filter(t=>!t.alternative).slice(0,2)){
  lines.push('*'+trip.route.join(' → ')+'*');
  lines.push(trip.bikes+' bike'+(trip.bikes===1?'':'s')+(trip.cars?' · '+trip.cars+' cars':'')+' · proposed '+trip.start.slice(5).split('-').reverse().join('/'));
 }
 lines.push('Loads, return opportunities and maps in Dispatch. Dates are proposals until agreed.');
 return lines.join('\n');
}
module.exports={planAhead,planningBrief,addDays};
