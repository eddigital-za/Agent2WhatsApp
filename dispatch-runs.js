'use strict';
const crypto=require('node:crypto');
const {closed,customerFirstName}=require('./dispatch-domain');
const WOODHAVEN='Woodhaven, Durban, South Africa';
const POMONA='Cheetah Express Depot, Pomona, Kempton Park, South Africa';
const day=(date,n)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function region(value){
 const text=String(value||'').toLowerCase();
 const aliases=[
 ['Cape Town',/\b(cpt|cape town|paarl|pearl valley|hout bay|rondebosch|stellenbosch|somerset west)\b/],
 ['Durban',/\b(dbn|durban|ballito|pmb|pietermaritzburg|woodhaven|queensburgh|pinetown|kzn)\b/],
 ['Johannesburg',/\b(jhb|johannesburg|joburg|pomona|kempton|randburg|sandton|edenvale|fourways|gauteng|pta|pretoria|montana|centurion)\b/],
 ['Bloemfontein',/\b(bloemfontein|bloem|pellissier)\b/],
 ['Hoedspruit',/\bhoedspruit\b/],['Malelane',/\bmalelane\b/],
 ['Gqeberha',/\b(gqeberha|port elizabeth|st[.]? francis|pe)\b/],
 ['East London',/\b(east london|el)\b/],['George',/\bgeorge\b/]];
 return aliases.find(([,pattern])=>pattern.test(text))?.[0]||'';
}
function routeParts(route){
 return String(route||'').split(/\s+(?:to|→)\s+|\s+-\s+|\s*[–—]\s*|(?<=[a-z)])-(?=[a-z(])/i).map(s=>s.trim()).filter(Boolean);
}
function vehicle(o){
 const count=o.quantity==null||String(o.quantity).trim()===''?1:Number(o.quantity);
 if(!Number.isInteger(count)||count<1||/\b\d+\s*[x×]/i.test(o.bike||''))return null;
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

function buildRuns(orders,today,decisions=[],kept=[]){
 const end=day(today,14),all=expand(orders),candidates=[],blocked=[],opportunities=[],future=[];
 const savedIds=new Set(kept.filter(p=>p.end>=today).flatMap(p=>p.source.map(s=>s.id)));
 const snoozed=new Set(decisions.filter(d=>d.state==='snoozed'&&d.until_day>today).map(d=>d.id));
 for(const o of all){
  if(savedIds.has(o.id))continue;
  const carriers=String(o.contractor||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  const own=carriers.length===1&&carriers[0]==='btsa',mixed=carriers.includes('btsa')&&carriers.some(s=>/cheet/.test(s));
  const parts=routeParts(o.route);
  const named=value=>value&&!/^(unknown|tbc|tbd|not specified|unspecified)$/i.test(value)?value:'';
  const from=region(parts[0])||region(o.collectionAddress)||named(parts[0]),to=region(parts.at(-1))||region(o.deliveryAddress)||named(parts.at(-1));
  const label=o.label,id=o.id;
  const load=vehicle(o),sourceSignature=fingerprint(o);
  if(!own&&!mixed){if(!carriers.length&&from&&to)opportunities.push({id,label,from,to,reason:'Unassigned: assign BTSA before including'});continue;}
  if(snoozed.has(id))continue;
  let reason='';
  if(o.actualCollection||['Collected','In Transit'].includes(o.status))reason='Already collected: confirm current location before planning another load';
  else if(parts.length>2)reason='Return route: add the separate return trip details';
  else if(!from||!to)reason='Confirm the route towns';
  else if(from===to)reason='Local job: review separately from the long-distance loads';
  else if(!load)reason='Check vehicle space and quantity';
  else if(o.syncState&&o.syncState!=='synced')reason='Resolve the sheet conflict before including';
  const fixedPickup=o.collection?.confidence==='confirmed'&&o.collection?.precision!=='week'?o.collection.date:'';
  const fixedDrop=o.delivery?.confidence==='confirmed'&&o.delivery?.precision!=='week'?o.delivery.date:'';
  if(!reason&&fixedPickup&&fixedPickup<today)reason='Past pickup: confirm collection or move the date';
  if(!reason&&fixedDrop&&fixedDrop<today)reason='Past delivery: confirm delivery or move the date';
  if(!reason&&fixedPickup&&fixedDrop&&(fixedDrop<fixedPickup||fixedDrop===fixedPickup&&o.collection?.time&&o.delivery?.time&&o.delivery.time<o.collection.time))reason='Delivery is before collection';
  if(reason){blocked.push({id,label,reason});continue;}
  if(fixedPickup>end){future.push({id,label,date:fixedPickup,from,to});continue;}
  let legFrom=from,legTo=to,partner='';
  if(mixed){
   if(from==='Durban'&&to!=='Johannesburg'){legTo='Johannesburg';partner='Proposed BTSA handover at Pomona; Cheetah onward dates need confirmation';}
   else if(to==='Durban'&&from!=='Johannesburg'){legFrom='Johannesburg';partner='Cheetah must confirm arrival at Pomona before BTSA loads';}
   else {blocked.push({id,label,reason:'Confirm BTSA’s leg on this shared booking'});continue;}
  }
  const pickupAddress=legFrom===from?(o.collectionAddress||from+', South Africa'):POMONA;
  const dropAddress=legTo===to?(o.deliveryAddress||to+', South Africa'):POMONA;
  // Mixed-trip final delivery is not a promise that the BTSA handover happens that day.
  candidates.push({id,ref:o.externalId,trip:o.trip,label,from:legFrom,to:legTo,finalTo:to,load,pickup:legFrom===from?fixedPickup:'',deadline:fixedDrop,delivery:legTo===to?fixedDrop:'',pickupAddress,dropAddress,pickupTime:o.collection?.time||'',deliveryTime:o.delivery?.time||'',partner,sourceSignature,priority:fixedDrop||fixedPickup||end,condition:mixed?'Partner confirmation needed':!fixedPickup||!fixedDrop?'Suggested dates':'Booked dates',original:o});
 }
 const groups=[];
 const sorted=candidates.sort((a,b)=>Number(!a.pickup)-Number(!b.pickup)||a.priority.localeCompare(b.priority)||a.label.localeCompare(b.label));
 for(const item of sorted){
  const destination=item.from==='Johannesburg'&&['Hoedspruit','Malelane'].includes(item.to)?'Lowveld':item.to;
  const days=allowance(item.from,destination);
  let group=groups.find(g=>g.from===item.from&&g.to===destination&&(!item.pickup||g.date===item.pickup)&&(!item.deadline||g.date<=item.deadline));
  if(!group){
   const target=item.pickup||(item.deadline?day(item.deadline,-days):day(today,7));
   group={from:item.from,to:destination,date:target<today?today:target>end?day(today,7):target,items:[]};groups.push(group);
  }
  group.items.push(item);
 }
 function makeRun(items,from,to,date,alternative=false){
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
  for(const i of items)sequence.push({kind:i.partner&&to==='Johannesburg'?'Handover':'Drop-off',address:i.dropAddress,label:i.label,jobId:i.id,date:i.delivery||arrival,time:i.deliveryTime,proposed:!i.delivery});
  const source=items.map(i=>({id:i.id,signature:i.sourceSignature}));
  const id=hash([from,to,date,items.map(i=>i.id).sort(),alternative]).slice(0,24);
  const signature=hash([source,date,arrival,alternative]);
  return {id,signature,from,to,date,end:arrival,jobs:items.map(i=>i.id),members:items.map(({original,...i})=>i),source,bikes,cars,capacity,spare:capacity-bikes,trailer:cars?'1 car + up to 3 bikes':bikes>7?'Hire 6m trailer':bikes>5?'Own trailer · check fit':'Own trailer',warnings,sequence,maps:mapLinks(sequence),flexible:items.every(i=>!i.pickup&&!i.delivery),alternative,priority:items.map(i=>i.priority).sort()[0],proposed:items.some(i=>!i.pickup||!i.delivery)};
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
 // Offer direct Cape Town only as an alternative to the same Pomona load, never as extra booked volume.
 const alternatives=[];
 for(const run of runs){
  const cape=run.members.filter(i=>i.partner&&i.from==='Durban'&&i.finalTo==='Cape Town');
  if(cape.reduce((n,i)=>n+i.load.bikes,0)<5)continue;
  const items=cape.map(i=>({...i,to:'Cape Town',dropAddress:candidates.find(c=>c.id===i.id).original.deliveryAddress||'Cape Town, South Africa',delivery:i.deadline,partner:'Alternative to Pomona handover: confirm Cheetah is no longer handling this leg'}));
  const direct=makeRun(items,'Durban','Cape Town',run.date,true);direct.alternativeTo=run.id;alternatives.push(direct);
 }
 runs.sort((a,b)=>a.date.localeCompare(b.date)||a.priority.localeCompare(b.priority)||b.bikes-a.bikes);
 // Connect loads into journeys. Proposed return dates may move; booked dates never move.
 const journeys=[],used=new Set();
 const shift=(run,date)=>{
  const delta=Math.round((new Date(date+'T12:00:00Z')-new Date(run.date+'T12:00:00Z'))/86400000);
  run.date=date;run.end=day(run.end,delta);run.sequence=run.sequence.map(s=>({...s,date:day(s.date,delta)}));
  run.signature=hash([run.source,run.date,run.end,run.alternative]);
 };
 const starts=[...runs.filter(r=>r.from==='Durban'),...runs.filter(r=>r.from!=='Durban')];
 for(const start of starts){
  if(used.has(start.id))continue;
  const legs=[start];used.add(start.id);
  for(let n=0;n<2;n++){
   const last=legs.at(-1);
   if(last.to===start.from)break;
   const next=runs.filter(r=>!used.has(r.id)&&r.from===last.to&&(r.date>=day(last.end,1)||r.flexible&&day(last.end,1)<=end)&&(!r.members.some(i=>i.deadline&&i.deadline<day(last.end,1)))).sort((a,b)=>Number(b.to===start.from)-Number(a.to===start.from)||a.date.localeCompare(b.date)||b.bikes-a.bikes)[0];
   if(!next)break;
   if(next.flexible&&next.date<day(last.end,1))shift(next,day(last.end,1));
   if(next.date>end)break;
   legs.push(next);used.add(next.id);
  }
  const source=legs.flatMap(r=>r.source);
  const id=hash(legs.map(r=>r.id)).slice(0,24),signature=hash(legs.map(r=>r.signature));
  journeys.push({id,signature,legs,source,start:legs[0].date,end:legs.at(-1).end,route:[legs[0].from,...legs.map(r=>r.to)],bikes:legs.reduce((n,r)=>n+r.bikes,0),cars:legs.reduce((n,r)=>n+r.cars,0),alternative:false});
 }
 for(const run of alternatives)journeys.push({id:run.id,signature:run.signature,legs:[run],source:run.source,start:run.date,end:run.end,route:[run.from,run.to],bikes:run.bikes,cars:run.cars,alternative:true,alternativeTo:run.alternativeTo});
 const current=new Map(all.map(o=>[o.id,fingerprint(o)]));
 const accepted=kept.map(plan=>({...plan,changed:plan.source.some(s=>current.get(s.id)!==s.signature),expired:plan.end<today}));
 const reserved=new Set(accepted.filter(p=>!p.expired).flatMap(p=>p.source.map(s=>s.id)));
 const proposals=journeys.filter(j=>!j.source.some(s=>reserved.has(s.id)));
 const directions=[...new Set(candidates.map(i=>i.from+' → '+i.to))].map(route=>{const items=candidates.filter(i=>i.from+' → '+i.to===route);return {route,bikes:items.reduce((n,i)=>n+i.load.bikes,0),cars:items.reduce((n,i)=>n+i.load.cars,0),undated:items.filter(i=>!i.pickup).length};});
 return {today,end,origin:WOODHAVEN,handover:POMONA,journeys:proposals,accepted,blocked,opportunities,future,directions,runs};
}
module.exports={buildRuns,mapLinks,region,routeParts};
