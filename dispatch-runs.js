'use strict';
const crypto=require('node:crypto');
const {nearby,orderStops,generateOptions}=require('./dispatch-route-options');
const {closed,customerFirstName}=require('./dispatch-domain');
const WOODHAVEN='Woodhaven, Durban, South Africa';
const POMONA='Cheetah Express Depot, Pomona, Kempton Park, South Africa';
const day=(date,n)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const {region}=require('./dispatch-locations');
function routeParts(route){
 return String(route||'').split(/\s+(?:to|→)\s+|\s+-\s+|\s*[–—]\s*|(?<=[a-z)])-(?=[a-z(])/i).map(s=>s.trim()).filter(Boolean);
}
function vehicle(o){
 const count=o.quantity==null||String(o.quantity).trim()===''?1:Number(o.quantity);
 if(!Number.isInteger(count)||count<1||/^\s*\d+\s*[x×]\s+|\b\d+\s+[x×]\s+/i.test(o.bike||''))return null;
 if(/\b(car|beetle|qute|bakkie|sedan|suv)\b/i.test(o.bike||''))return {cars:count,bikes:0};
 if(/\b(quad|tuk\s*tuk|boat|caravan|trailer|furniture)\b/i.test(o.bike||''))return null;
 return {cars:0,bikes:count};
}
function expand(orders){
 return orders.flatMap(order=>{
  const trips=[{...order,trip:1}];
  if(order.returnTrip)trips.push({...order,...order.returnTrip,trip:2,actualCollection:order.returnTrip.actualCollection||null,actualDelivery:order.returnTrip.actualDelivery||null,collection:order.returnTrip.collection||null,delivery:order.returnTrip.delivery||null,legs:order.returnTrip.legs||[],collectionAddress:order.returnTrip.collectionAddress||order.deliveryAddress,deliveryAddress:order.returnTrip.deliveryAddress||order.collectionAddress,route:routeParts(order.route).reverse().join(' → ')});
  return trips.filter(o=>!closed(o.status)).map(o=>({...o,id:order.externalId+':'+o.trip,label:[o.bike,customerFirstName(o)].filter(Boolean).join(' · ')+(o.trip===2?' · Return':'')}));
 });
}
function allowance(from,to){return [from,to].includes('Cape Town')?4:[from,to].includes('Gqeberha')||[from,to].includes('East London')?3:2;}
function fingerprint(o){
 return hash([o.id,o.clientName,o.collectionContact,o.deliveryContact,o.status,o.contractor,o.route,o.bike,o.quantity,o.collection,o.delivery,o.legs,o.actualCollection,o.actualDelivery,o.collectionAddress,o.deliveryAddress,o.syncState]);
}
function mapLinks(stops){
 const links=[];
 // Google Maps mobile URLs support three waypoints; repeat the boundary stop.
 for(let start=0;start<stops.length-1;start+=4){
  const part=stops.slice(start,start+5);
  const params=new URLSearchParams({api:'1',travelmode:'driving',origin:part[0].address,destination:part.at(-1).address});
  if(part.length>2)params.set('waypoints',part.slice(1,-1).map(s=>s.address).join('|'));
  const url='https://www.google.com/maps/dir/?'+params;
  if(url.length<=2048)links.push({label:'Open map · stops '+(start+1)+'–'+(start+part.length),url});
  else for(let i=1;i<part.length;i++)links.push({label:'Open map · stops '+(start+i)+'–'+(start+i+1),url:'https://www.google.com/maps/dir/?'+new URLSearchParams({api:'1',travelmode:'driving',origin:part[i-1].address,destination:part[i].address})});
 }
 return links;
}

function buildRuns(orders,today,decisions=[],kept=[],options={}){
 const end=day(today,14),all=expand(orders),candidates=[],blocked=[],opportunities=[],future=[],partners=[],deferred=[];
 const snoozed=new Set(decisions.filter(d=>d.state==='snoozed'&&d.until_day>today).map(d=>d.id));
 for(const o of all){
  const carriers=String(o.contractor||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  const own=carriers.length===1&&carriers[0]==='btsa',mixed=carriers.includes('btsa')&&carriers.some(s=>/cheet/.test(s));
  const parts=routeParts(o.route);
  const named=value=>value&&!/^(unknown|tbc|tbd|not specified|unspecified)$/i.test(value)?value:'';
  const from=region(parts[0],o.collectionAddress),to=region(parts.at(-1),o.deliveryAddress);
  const label=o.label,id=o.id;
  const load=vehicle(o),sourceSignature=fingerprint(o);
  if(!own&&!mixed){const item={id,label,from,to,load,reason:carriers.length?'Partner-controlled: '+o.contractor+'; confirm a BTSA leg before including':'Unassigned: assign BTSA before including'};(carriers.length?partners:opportunities).push(item);}
  if(snoozed.has(id)){deferred.push({id,label,reason:'Reminder postponed until tomorrow'});continue;}
  let reason='';
  if(o.status==='Paused')reason='Paused booking: confirm it is ready before including';
  else if(o.actualCollection||['Collected','In Transit'].includes(o.status))reason='Already collected: confirm current location before planning another load';
  else if(parts.length>2)reason='Return route: add the separate return trip details';
  else if(!from||!to)reason='Confirm the route towns';
  else if(from===to)reason='Local job: review separately from the long-distance loads';
  else if(!load)reason='Check vehicle space and quantity';
  else if(o.syncState&&o.syncState!=='synced')reason='Resolve the sheet conflict before including';
  const fixedPickup=o.collection?.confidence==='confirmed'&&o.collection?.precision!=='week'?o.collection.date:'';
  const fixedDrop=o.delivery?.confidence==='confirmed'&&o.delivery?.precision!=='week'?o.delivery.date:'';
  if(!reason&&fixedPickup&&fixedPickup<today)reason='Past pickup: confirm collection or move the date';
  if(!reason&&fixedDrop&&fixedDrop<today)reason='Past delivery: confirm delivery or move the date';
  if(!reason&&(o.legs||[]).some(l=>l.handoverAt&&fixedPickup&&l.handoverAt.slice(0,10)<fixedPickup))reason='Handover is before collection; correct the dates before planning';
  if(!reason&&fixedPickup&&fixedDrop&&(fixedDrop<fixedPickup||fixedDrop===fixedPickup&&o.collection?.time&&o.delivery?.time&&o.delivery.time<o.collection.time))reason='Delivery is before collection';
  if(reason){blocked.push({id,label,reason});continue;}
  if(fixedPickup>end){future.push({id,label,date:fixedPickup,from,to});continue;}
  const assignmentRequired=!own&&!mixed;
  let legFrom=from,legTo=to,partner=assignmentRequired?(carriers.length?'Proposed BTSA takeover: agree release and timing with '+o.contractor:'Unassigned booking: BTSA assignment needs agreement'):'';
  if(mixed){
   if(from==='Durban'&&to!=='Johannesburg'){legTo='Johannesburg';partner='Proposed BTSA handover at Pomona; Cheetah onward dates need confirmation';}
   else if(to==='Durban'&&from!=='Johannesburg'){legFrom='Johannesburg';partner='Cheetah must confirm arrival at Pomona before BTSA loads';}
   else {blocked.push({id,label,reason:'Confirm BTSA’s leg on this shared booking'});continue;}
  }
  const pickupAddress=legFrom===from?(o.collectionAddress||from+', South Africa'):POMONA;
  const dropAddress=legTo===to?(o.deliveryAddress||to+', South Africa'):POMONA;
  // Mixed-trip final delivery is not a promise that the BTSA handover happens that day.
  candidates.push({id,ref:o.externalId,trip:o.trip,label,from:legFrom,to:legTo,finalTo:to,load,pickup:legFrom===from?fixedPickup:'',deadline:fixedDrop,delivery:legTo===to?fixedDrop:'',pickupAddress,dropAddress,pickupTime:o.collection?.time||'',deliveryTime:o.delivery?.time||'',partner,sourceSignature,assignmentRequired,priority:fixedDrop||fixedPickup||end,condition:assignmentRequired?'BTSA assignment needs agreement':mixed?'Partner confirmation needed':!fixedPickup||!fixedDrop?'Suggested dates':'Booked dates',original:o});
 }
 const groups=[];
 const sorted=candidates.sort((a,b)=>Number(!a.pickup)-Number(!b.pickup)||a.priority.localeCompare(b.priority)||a.label.localeCompare(b.label));
 for(const item of sorted){
  const destination=item.to;
  const days=allowance(item.from,destination);
  let group=groups.find(g=>g.from===item.from&&(g.to===destination||g.items.every(member=>nearby(member.to,destination)))&&(!item.pickup||g.date===item.pickup)&&(!item.deadline||g.date<=item.deadline));
  if(!group){
   const target=item.pickup||(item.deadline?day(item.deadline,-days):day(today,7));
   group={from:item.from,to:destination,date:target<today?today:target>end?day(today,7):target,items:[]};groups.push(group);
  }
  group.items.push(item);
 }
 function makeRun(items,from,to,date,alternative=false){
  items=orderStops(items,from);to=items.at(-1).to;
  const days=allowance(from,to);
  const booked=items.map(i=>i.delivery).filter(Boolean).sort();
  const arrival=booked.at(-1)||day(date,days);
  const warnings=[...new Set(items.map(i=>i.partner).filter(Boolean))];
  if(items.some(i=>(i.original?.legs||[]).some(l=>l.handoverAt&&l.handoverAt.slice(0,10)<(i.pickup||date))))warnings.push('An existing handover is before collection. Correct it before confirming the run.');
  if(items.some(i=>i.pickupTime||i.deliveryTime))warnings.push('Booked appointment times apply. Check travel time between stops.');
  const early=items.some(i=>i.deadline&&i.deadline<day(date,days));
  if(early)warnings.push('Tight deadline: check driving time and customer availability before using this plan');
  const bikes=items.reduce((n,i)=>n+i.load.bikes,0),cars=items.reduce((n,i)=>n+i.load.cars,0);
  const capacity=cars?3:bikes>7?11:bikes>5?7:5;
  if(!cars&&bikes>5&&bikes<=7)warnings.push('Check the bike sizes: six or seven may fit your own trailer');
  const sequence=[{kind:'Start',address:from==='Durban'?WOODHAVEN:from==='Johannesburg'?POMONA:from+', South Africa',date}];
  for(const i of items)sequence.push({kind:'Pickup',address:i.pickupAddress,label:i.label,jobId:i.id,date:i.pickup||date,time:i.pickupTime,proposed:!i.pickup});
  for(const i of items){
   if(i.partner)continue;
   for(const leg of i.original?.legs||[]){
    if(!leg.handoverAt||['Handed over','Delivered','Cancelled'].includes(leg.status))continue;
    const [handoverDate,time='']=leg.handoverAt.split('T');
    sequence.push({kind:'Handover',address:leg.to||POMONA,label:i.label,jobId:i.id,date:handoverDate,time,proposed:leg.handoverConfidence!=='confirmed'});
   }
  }
  for(const i of items)sequence.push({kind:i.partner&&!i.assignmentRequired&&!i.directMode&&to==='Johannesburg'?'Handover':'Drop-off',address:i.dropAddress,label:i.label,jobId:i.id,date:i.delivery||arrival,time:i.deliveryTime,proposed:!i.delivery});
  const source=items.map(i=>({id:i.id,signature:i.sourceSignature}));
  const id=hash([from,to,date,items.map(i=>i.id).sort(),alternative]).slice(0,24);
  const signature=hash([source,date,arrival,alternative]);
  const towns=[from,...new Set(items.map(i=>i.to))];
  return {id,signature,from,to,towns,date,end:arrival,jobs:items.map(i=>i.id),members:items.map(({original,...i})=>i),source,bikes,cars,capacity,spare:capacity-bikes,trailer:cars?'1 car + up to 3 bikes':bikes>7?'Hire 6m trailer':bikes>5?'Own trailer · check fit':'Own trailer',warnings,sequence,maps:mapLinks(sequence),flexible:items.every(i=>!i.pickup&&!i.delivery),alternative,priority:items.map(i=>i.priority).sort()[0],proposed:items.some(i=>!i.pickup||!i.delivery)};
 }
 const runs=[];
 for(const group of groups){
  const waiting=[...group.items];
  while(waiting.length){
   const members=[];let bikes=0,cars=0;
   for(let n=0;n<waiting.length;){
    const i=waiting[n],nc=cars+i.load.cars,nb=bikes+i.load.bikes;
    if(nc<=1&&nb<=(nc?3:11)){members.push(i);cars=nc;bikes=nb;waiting.splice(n,1);}else n++;
   }
   if(!members.length){const i=waiting.shift();blocked.push({id:i.id,label:i.label,reason:'Booking exceeds one load; split its quantity before planning'});continue;}
   runs.push(makeRun(members,group.from,group.to,group.date));
  }
 }

 // Shared-booking handovers and direct BTSA carriage are competing cargo variants.
 // Every destination is evaluated; no threshold or named route is privileged.
 const alternatives=[];
 for(const run of runs){
   const variants=new Map();
  for(const i of run.members.filter(i=>i.partner&&!i.assignmentRequired)){
   const original=candidates.find(c=>c.id===i.id).original,parts=routeParts(original.route);
   const from=region(parts[0])||parts[0],to=region(parts.at(-1))||parts.at(-1);
   if(from===i.from&&to===i.to)continue;
   const key=from+'|'+to;
   if(!variants.has(key))variants.set(key,[]);
   variants.get(key).push({...i,from,to,directMode:true,assignmentRequired:true,pickup:original.collection?.confidence==='confirmed'?original.collection.date:'',delivery:original.delivery?.confidence==='confirmed'?original.delivery.date:'',pickupAddress:original.collectionAddress||from+', South Africa',dropAddress:original.deliveryAddress||to+', South Africa',partner:'Direct BTSA option: agree the change with the assigned partner',condition:'Direct BTSA option · assignment needs agreement'});
  }
  for(const items of variants.values()){
   const direct=makeRun(items,items[0].from,items[0].to,run.date,true);direct.directVariant=true;alternatives.push(direct);
  }
 }
 // Draft circuits can propose changed dates, but never write those dates to bookings.
 
 function align(run,ready){
  const originalDate=run.date;
  const date=run.date<ready?ready:run.date;
  const minimumEnd=day(date,allowance(run.from,run.to));
  const finish=run.end<minimumEnd?minimumEnd:run.end;
  const changes=[];
  run.sequence=run.sequence.map(stop=>{
   let proposed=stop.date;
   if(stop.kind==='Start'||stop.kind==='Pickup')proposed=date;
   else if(stop.date<date||stop.kind==='Drop-off'||stop.kind==='Handover')proposed=finish;
   if(proposed!==stop.date){
    if(!stop.proposed&&stop.jobId&&stop.kind!=='Start')changes.push({jobId:stop.jobId,kind:stop.kind,booked:stop.date,proposed});
    return {...stop,bookedDate:stop.proposed||!stop.jobId||stop.kind==='Start'?undefined:stop.date,date:proposed,proposed:true};
   }
   return stop;
  });
  run.date=date;run.end=finish;
  run.dateChanges=changes;
  if(changes.length)run.warnings.push('This combined trip needs agreement on '+changes.length+' booked stop date'+(changes.length===1?'':'s')+'. Original dates remain unchanged.');
  if(originalDate!==date||changes.length)run.proposed=true;
  run.maps=mapLinks(run.sequence);
  run.signature=hash([run.source,run.date,run.end,run.sequence]);
 }
 const hubAddress=town=>town==='Johannesburg'?POMONA:town==='Durban'?WOODHAVEN:town+', South Africa';
 // Recompute ranked circuits from every current load and its direct variants.
 const journeys=options.skipSearch?[]:generateOptions([...runs,...alternatives],today,end,{day,hash,mapLinks,align,hubAddress});
 const current=new Map(all.map(o=>[o.id,fingerprint(o)]));
 const accepted=kept.map(plan=>({...plan,changed:plan.source.some(s=>current.get(s.id)!==s.signature),expired:plan.end<today}));
 const proposals=journeys.filter(j=>{
  const overlaps=accepted.filter(p=>!p.expired&&p.source.some(s=>j.source.some(item=>item.id===s.id)));
  if(!overlaps.length)return true;
  // A replacement must retain every order in the saved plan.
  if(overlaps.some(p=>p.source.some(s=>!j.source.some(item=>item.id===s.id))))return false;
  const unchanged=overlaps.length===1&&!overlaps[0].changed&&overlaps[0].source.length===j.source.length&&JSON.stringify(overlaps[0].route)===JSON.stringify(j.route);
  if(unchanged)return false;
  j.replaces=overlaps.map(p=>p.id);
  return true;
 });
 const directions=[...new Set(candidates.map(i=>i.from+' → '+i.to))].map(route=>{const items=candidates.filter(i=>i.from+' → '+i.to===route);return {route,bikes:items.reduce((n,i)=>n+i.load.bikes,0),cars:items.reduce((n,i)=>n+i.load.cars,0),undated:items.filter(i=>!i.pickup).length};});


 for(const proposal of proposals){
  proposal.maps=mapLinks(proposal.legs.flatMap(leg=>leg.sequence));
  proposal.opportunities=opportunities.filter(o=>proposal.legs.some(leg=>leg.from===o.from&&(leg.to===o.to||nearby(leg.to,o.to))));
 }
 const planned=new Set(proposals.filter(p=>!p.alternative).flatMap(p=>p.source.map(s=>s.id)));
 const saved=new Set(accepted.filter(p=>!p.expired).flatMap(p=>p.source.map(s=>s.id)));
 const categories=[['review',blocked],['unassigned',opportunities],['partner',partners],['later',future],['postponed',deferred]];
 const coverage=all.map(o=>{
  let state=saved.has(o.id)?'saved':planned.has(o.id)?'proposed':'review',reason='';
  for(const [category,items] of categories){const item=items.find(i=>i.id===o.id);if(item){state=category;reason=item.reason||(category==='later'?'Pickup beyond 14 days: '+item.date:'');break;}}
  if(state==='review'&&!reason)reason='Needs review before joining a load';
  return {id:o.id,ref:o.externalId,trip:o.trip,label:o.label,route:o.route,state,reason};
 });
 const bookingCount=new Set(coverage.map(o=>o.ref)).size;
 const coverageCounts=Object.fromEntries(['proposed','saved','review','unassigned','partner','later','postponed'].map(state=>[state,coverage.filter(o=>o.state===state).length]));
 return {today,end,origin:WOODHAVEN,handover:POMONA,journeys:proposals,accepted,blocked,opportunities,future,directions,runs,partners,deferred,coverage,bookingCount,tripCount:coverage.length,coverageCounts};
}
module.exports={buildRuns,mapLinks,region,routeParts,expand,vehicle,fingerprint,WOODHAVEN,POMONA};
