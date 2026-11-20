'use strict';
// Regional reference points, not customer locations or road distances.
// https://www.geonames.org/za/largest-cities-in-south-africa.html
// https://www.saps.gov.za/contacts/stationdetails.php?sid=141 (George)
// https://www.saps.gov.za/contacts/stationdetails.php?sid=1046 (Malelane)
const POINTS={'Durban':[-29.858,31.029],'Johannesburg':[-26.202,28.044],'Cape Town':[-33.926,18.423],'Bloemfontein':[-29.121,26.214],'Gqeberha':[-33.961,25.615],'East London':[-33.015,27.912],'George':[-33.957,22.460],'Malelane':[-25.494,31.511],'Hoedspruit':[-24.35,30.95]};
function distance(a,b){
 if(a===b)return 0;
 const x=POINTS[a],y=POINTS[b];if(!x||!y)return null;
 const rad=n=>n*Math.PI/180,dlat=rad(y[0]-x[0]),dlon=rad(y[1]-x[1]);
 const h=Math.sin(dlat/2)**2+Math.cos(rad(x[0]))*Math.cos(rad(y[0]))*Math.sin(dlon/2)**2;
 return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
}
function nearby(a,b){const km=distance(a,b);return km!==null&&km<=180;}
function orderStops(items,from){
 const pending=[...items],ordered=[];let town=from;
 while(pending.length){
  pending.sort((a,b)=>(distance(town,a.to)??Infinity)-(distance(town,b.to)??Infinity)||a.label.localeCompare(b.label));
  const next=pending.shift();ordered.push(next);town=next.to;
 }
 return ordered;
}
function generateOptions(pool,today,end,{day,hash,mapLinks,align,hubAddress}){
 if(!pool.length)return [];
 function position(from,to,date,address){
  const km=distance(from,to),finish=day(date,km===null?2:Math.max(1,Math.ceil(km/500)));
  const sequence=[{kind:'Start',address:address||hubAddress(from),date},{kind:'Reposition',address:hubAddress(to),date:finish,proposed:true}];
  return {id:'empty-'+hash([from,to,date]).slice(0,16),signature:hash(sequence),from,to,towns:[from,to],date,end:finish,jobs:[],members:[],source:[],bikes:0,cars:0,capacity:0,spare:0,trailer:'Empty trailer',warnings:['Empty positioning. Day allowances and regional straight-line distances are screening guides; check roads and timing in Maps.'],sequence,maps:mapLinks(sequence),reposition:true,proposed:true};
 }
 function kilometres(leg){
  const towns=leg.towns||[leg.from,leg.to];let km=0,unknown=0;
  for(let i=1;i<towns.length;i++){const d=distance(towns[i-1],towns[i]);if(d===null)unknown++;else km+=d;}
  return {km,unknown};
 }
 function measure(legs){
  let km=0,empty=0,unknown=0,changes=0,conditions=0,space=0,used=0;
  const changedJobs=new Set();
  for(const leg of legs){
   const metric=kilometres(leg);km+=metric.km;unknown+=metric.unknown;if(leg.reposition)empty+=metric.km;
   for(const change of leg.dateChanges||[]){changes+=Math.abs((new Date(change.proposed)-new Date(change.booked))/86400000);changedJobs.add(change.jobId);}
   conditions+=leg.members.filter(m=>m.assignmentRequired||m.partner).length;
   if(!leg.reposition){space+=leg.cars?6:leg.capacity;used+=leg.bikes+leg.cars*3;}
  }
  return {km,empty,unknown,dateChangeDays:changes,changedOrders:changedJobs.size,conditions,fill:space?used/space:0,emptyLegs:legs.filter(l=>l.reposition).length};
 }
 function finish(state){
  const legs=[...state.legs],last=legs.at(-1);
  if(last.to!=='Durban')legs.push(position(last.to,'Durban',last.end,last.sequence.at(-1).address));
  if(legs.at(-1).end>day(end,7))return null;
  const source=legs.flatMap(l=>l.source),route=[];
  for(const leg of legs)for(const town of leg.towns||[leg.from,leg.to])if(route.at(-1)!==town)route.push(town);
  const metrics=measure(legs),units=legs.reduce((n,l)=>n+l.bikes+l.cars*3,0);
  // Screening score: productive loads versus geography, empty positioning, date
  // changes and conditional assignments. This is not a profit or fuel estimate.
  const score=source.length*700+units*100+metrics.fill*150-metrics.km*.25-metrics.empty*.8-metrics.dateChangeDays*60-metrics.conditions*160-metrics.unknown*900;
  const id=hash(legs.map(l=>l.id)).slice(0,24),signature=hash(legs.map(l=>l.signature));
  return {id,signature,legs,source,start:legs[0].date,end:legs.at(-1).end,route,dateChanges:legs.flatMap(l=>l.dateChanges||[]),bikes:legs.reduce((n,l)=>n+l.bikes,0),cars:legs.reduce((n,l)=>n+l.cars,0),metrics,score,alternative:false,assignmentRequired:legs.flatMap(l=>l.members).filter(m=>m.assignmentRequired).map(m=>m.id)};
 }
 // ponytail: bounded beam search, not exhaustive VRP; caps work on each refresh.
 // Every option includes Woodhaven positioning and return, so empty distance is
 // compared consistently instead of favouring a far-away load in isolation.
 let beam=[{legs:[],used:new Set(),town:'Durban',date:today}],expansions=0;
 const completed=new Map();
 for(let depth=0;depth<Math.min(pool.length,8)&&beam.length&&expansions<6000;depth++){
  const next=[];
  for(const state of beam){
   for(const template of pool){
    // A return to Woodhaven closes this circuit; another departure is a separate option.
    if(state.legs.length&&(state.town==='Durban'||template.from==='Durban'))continue;
    if(template.source.some(s=>state.used.has(s.id)))continue;
    if(++expansions>6000)break;
    const legs=[...state.legs];
    let ready=state.date;
    if(state.town!==template.from){
     const km=distance(state.town,template.from),travelDays=km===null?2:Math.max(1,Math.ceil(km/500));
     const leave=day(template.date,-travelDays)>ready?day(template.date,-travelDays):ready;
     const empty=position(state.town,template.from,leave,legs.at(-1)?.sequence.at(-1).address);legs.push(empty);ready=empty.end;
    }
    const leg=structuredClone(template);align(leg,ready);
    if(leg.date>end||leg.end>day(end,7))continue;
    legs.push(leg);
    const used=new Set([...state.used,...leg.source.map(s=>s.id)]);
    const item={legs,used,town:leg.to,date:leg.end};
    const result=finish(item);if(!result)continue;
    const key=used.size+'|'+[...used].sort().join('|')+'|'+result.route.join('|');
    const prior=completed.get(key);if(!prior||result.score>prior.score)completed.set(key,result);
    next.push({...item,score:result.score});
   }
  }
  next.sort((a,b)=>b.score-a.score);
  // Keep distinct cargo/end-town combinations, not 36 copies of one permutation.
  const seen=new Set();
  beam=next.filter(s=>{const key=[...s.used].sort().join('|')+'|'+s.town;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,36);
 }
 const ranked=[...completed.values()].sort((a,b)=>b.score-a.score||a.signature.localeCompare(b.signature));
 const chosen=[],covered=new Set();
 // Primary proposals cover all routable orders without double booking.
 while(true){
  const remaining=ranked.filter(j=>j.source.every(s=>!covered.has(s.id)));
  if(!remaining.length)break;
  const best=remaining[0];chosen.push(best);for(const s of best.source)covered.add(s.id);
 }
 // Offer genuinely different choices, not every permutation of the same trip.
 const variants=[];
 for(const best of chosen){
  const overlap=ranked.filter(j=>j.id!==best.id&&j.source.some(s=>best.source.some(b=>b.id===s.id)));
  const picks=[
   overlap.filter(j=>j.source.length>=best.source.length&&j.metrics.changedOrders<best.metrics.changedOrders).sort((a,b)=>a.metrics.dateChangeDays-b.metrics.dateChangeDays||b.score-a.score)[0],
   overlap.filter(j=>j.source.length>=Math.max(1,best.source.length-1)&&j.metrics.empty+50<best.metrics.empty).sort((a,b)=>a.metrics.empty-b.metrics.empty||b.score-a.score)[0],
   overlap.find(j=>j.legs.some(l=>l.directVariant)&&!best.legs.some(l=>l.directVariant)),
   overlap.find(j=>!j.legs.some(l=>l.directVariant)&&best.legs.some(l=>l.directVariant))
  ].filter(Boolean);
  for(const alternative of picks){if(variants.some(j=>j.id===alternative.id))continue;variants.push({...alternative,alternative:true,alternativeTo:best.id});if(variants.length>=4)break;}
  if(variants.length>=4)break;
 }
 for(const proposal of [...chosen,...variants]){
  proposal.reasons=[proposal.source.length+' order'+(proposal.source.length===1?'':'s')+' in one circuit',proposal.metrics.emptyLegs+' empty positioning leg'+(proposal.metrics.emptyLegs===1?'':'s'),proposal.metrics.changedOrders?proposal.metrics.changedOrders+' orders need date agreement':'No booked date changes',proposal.metrics.conditions?proposal.metrics.conditions+' partner / assignment checks':'BTSA-assigned work'];
  const baseline=chosen.find(j=>j.id===proposal.alternativeTo);
  proposal.comparison=!proposal.alternative?'Recommended combination':proposal.legs.some(l=>l.directVariant)?'Direct BTSA option':baseline&&proposal.metrics.changedOrders<baseline.metrics.changedOrders?'Fewer booked-date changes':baseline&&proposal.metrics.empty<baseline.metrics.empty?'Less empty positioning':'Alternative circuit';
 }
 return [...chosen,...variants];
}
module.exports={distance,nearby,orderStops,generateOptions};
