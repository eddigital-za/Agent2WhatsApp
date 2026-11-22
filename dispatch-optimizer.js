'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const {buildRuns,expand,fingerprint,routeParts,mapLinks,WOODHAVEN,POMONA}=require('./dispatch-runs');
const {localDay}=require('./dispatch-domain');
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
// Public town centres only. Exact addresses remain in Dispatch for Maps links.
const POINTS={Durban:[31.029,-29.858],Johannesburg:[28.044,-26.202],'Cape Town':[18.423,-33.926],Malelane:[31.511,-25.494],Hoedspruit:[30.95,-24.35],'Herolds Bay':[22.397,-34.05],Dundee:[30.234,-28.166],Pietermaritzburg:[30.379,-29.6],Paarl:[18.963,-33.734],Suurbraak:[20.652,-34.016],George:[22.46,-33.957],Bloemfontein:[26.214,-29.121],Gqeberha:[25.615,-33.961],'East London':[27.912,-33.015]};
function town(value){
 const text=String(value||'').trim();
 const patterns=[['Herolds Bay',/herold.?s? bay/i],['Paarl',/paarl|pearl valley/i],['Suurbraak',/suurbraak|stuurbraak|stuurbrak|swellendam/i],['Dundee',/dundee/i],['Pietermaritzburg',/\b(pmb|pietermaritzburg)\b/i],['Durban',/\b(dbn|durban|ballito|woodhaven|queensburgh|pinetown)\b/i],['Johannesburg',/\b(jhb|joburg|johannesburg|pta|pretoria|montana|sandton|pomona|kempton|randburg|edenvale|fourways|centurion|roodepoort|roodeport)\b/i],['Cape Town',/\b(cpt|cape town|hout bay|rondebosch|milnerton|stellenbosch)\b/i],['Gqeberha',/\b(pe|gqeberha|port elizabeth|st\.? francis)\b/i],['East London',/\b(el|east london)\b/i],['Bloemfontein',/bloem|pellissier/i]];
 return patterns.find(([,re])=>re.test(text))?.[0]||Object.keys(POINTS).find(t=>text.toLowerCase()===t.toLowerCase())||text;
}
function runPython(payload,{python,timeout=45000}={}){
 return new Promise((resolve,reject)=>{
  const executable=python||process.env.PLANNER_PYTHON||(fs.existsSync('/app/.planner-venv/bin/python')?'/app/.planner-venv/bin/python':'python');
  const child=spawn(executable,[path.join(__dirname,'dispatch-solver.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MPLBACKEND:'Agg'}});
  let stdout='',stderr='',settled=false;
  const fail=error=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();reject(error);};
  const timer=setTimeout(()=>fail(Error('Trip optimisation timed out; existing orders are unchanged')),timeout);
  child.on('error',()=>fail(Error('The trip solver runtime is unavailable')));
  child.stdout.on('data',b=>{stdout+=b;if(stdout.length>2e6)fail(Error('Trip solver result exceeded its limit'));});
  child.stderr.on('data',b=>{stderr=(stderr+b).slice(-2000);});
  child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);if(code!==0)return reject(Error('Trip solver could not complete ('+code+')'));try{resolve(JSON.parse(stdout));}catch{reject(Error('Trip solver returned an invalid result'));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
 });
}
function createOptimizer({fetcher=globalThis.fetch,solve=runPython,now=()=>Date.now(),onResult=()=>{}}={}){
 let cached=null,pending=false,retryAt=0,failure='',desired=null;
 const matrices=new Map(),coordinates=new Map(Object.entries(POINTS));
 async function roads(towns){
  const key=towns.join('|'),existing=matrices.get(key);
  if(existing&&now()-existing.at<86400000)return existing.data;
  // Unknown route towns are geocoded as towns, never with customer addresses.
  for(const name of towns.filter(t=>!coordinates.has(t))){
   if(!/^[\p{L} .'-]{2,70}$/u.test(name))throw Error('A route town needs review');
   await new Promise(resolve=>setTimeout(resolve,1100));
   const response=await fetcher('https://nominatim.openstreetmap.org/search?'+new URLSearchParams({q:name+', South Africa',format:'json',countrycodes:'za',limit:'1'}),{headers:{'User-Agent':'BTSA-Dispatch-Planner/1.0 (town-level trip proposals)'},signal:AbortSignal.timeout(8000)});
   if(!response.ok)throw Error('Town lookup is temporarily unavailable');
   const rows=await response.json(),point=rows[0];
   if(!point||!Number.isFinite(Number(point.lon))||!Number.isFinite(Number(point.lat)))throw Error('A route town could not be located');
   coordinates.set(name,[Number(point.lon),Number(point.lat)]);
  }
  const response=await fetcher('https://router.project-osrm.org/table/v1/driving/'+towns.map(t=>coordinates.get(t).join(',')).join(';')+'?annotations=distance,duration&skip_waypoints=true',{signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error('Road estimates are temporarily unavailable');
  const data=await response.json(),n=towns.length;
  if(data.code!=='Ok'||!['distances','durations'].every(k=>Array.isArray(data[k])&&data[k].length===n&&data[k].every(row=>Array.isArray(row)&&row.length===n&&row.every(v=>Number.isFinite(v)&&v>=0))))throw Error('Road estimates are incomplete; no straight-line substitute was used');
  matrices.set(key,{at:now(),data});if(matrices.size>8)matrices.delete(matrices.keys().next().value);
  return data;
 }
 function prepare(orders,instant,decisions,kept){
  const today=localDay(instant),base=buildRuns(orders,today,decisions,kept,{skipSearch:true});
  const originals=new Map(expand(orders).map(o=>[o.id,o]));
  const members=[...new Map(base.runs.flatMap(r=>r.members).map(m=>[m.id,m])).values()];
  const jobs=[];
  for(const member of members){
   const o=originals.get(member.id),parts=routeParts(o.route);
   const activeLegs=(o.legs||[]).filter(l=>l.handoverAt&&!['Handed over','Delivered','Cancelled'].includes(l.status));
   if(activeLegs.length&&!member.partner){base.blocked.push({id:member.id,label:member.label,reason:'Confirm the handover transport leg before planning this booking'});continue;}
   const mixed=member.partner&&!member.assignmentRequired;
   const from=mixed&&member.from==='Johannesburg'?'Johannesburg':town(parts[0]);
   const to=mixed&&member.to==='Johannesburg'?'Johannesburg':town(parts.at(-1));
   if(from===to){base.blocked.push({id:member.id,label:member.label,reason:'Local stops need a separate local route'});continue;}
   jobs.push({...member,from,to,collection:mixed&&!member.pickup?null:o.collection,drop:to===town(parts.at(-1))?o.delivery:null,conditional:Boolean(member.assignmentRequired||member.partner)});
  }
  const direct=jobs.filter(m=>m.partner&&!m.assignmentRequired).map(m=>{const o=originals.get(m.id),parts=routeParts(o.route);return {...m,from:town(parts[0]),to:town(parts.at(-1)),pickupAddress:o.collectionAddress||town(parts[0])+', South Africa',dropAddress:o.deliveryAddress||town(parts.at(-1))+', South Africa',collection:o.collection,drop:o.delivery,directMode:true,conditional:true,assignmentRequired:true};});
  // Sheet versions, notes and record order change without changing a trip.
  const key=hash([today,[...originals.values()].map(o=>[o.id,fingerprint(o)]).sort((a,b)=>a[0].localeCompare(b[0])),[...decisions].sort((a,b)=>a.id.localeCompare(b.id)),kept.map(p=>[p.id,p.signature]).sort((a,b)=>a[0].localeCompare(b[0]))]);
  return {key,base,jobs,direct,instant,today,kept};
 }
 function decorate(request,result){
  if(!result||!Array.isArray(result.options))throw Error('Trip solver returned no option list');
  const {base,key,jobs,direct}=request;
  const journeys=result.options.map((option,index)=>{
   const lookup=new Map((option.direct?[...jobs,...direct]:jobs).map(j=>[j.id,j]));
   const members=option.jobs.map(i=>lookup.get(i));if(members.some(m=>!m))throw Error('Trip solver returned an unknown order');
   const source=members.map(m=>({id:m.id,signature:m.sourceSignature}));
   const stops=option.stops.map(s=>{
    const m=lookup.get(s.id),kind=s.kind==='Drop-off'&&m?.partner&&!m.assignmentRequired&&!m.directMode&&s.town==='Johannesburg'?'Handover':s.kind;return {...s,kind,jobId:s.id,label:m?.label||'',ref:m?.ref,trip:m?.trip,address:s.kind==='Start'||s.kind==='Return'?WOODHAVEN:m?(s.kind==='Pickup'?m.pickupAddress:m.dropAddress):s.town+', South Africa',proposed:!m||!(s.kind==='Pickup'?m.pickup:m.delivery)};
   });
   const id=hash([key,option.jobs,option.stops,option.capacity]).slice(0,24),signature=hash([source,stops,option.capacity]);
   const assignmentRequired=members.filter(m=>m.conditional).map(m=>m.id);
   const route=stops.reduce((out,s)=>{if(out.at(-1)!==s.town)out.push(s.town);return out;},[]);
   const warnings=['Town-level road estimates; check exact stops, trailer fit and safe overnight locations before departure.','Eight driving hours per day, 08:00–18:00 services, and driving breaks are planning assumptions; this is not a legal-hours certification.'];
   if(assignmentRequired.length)warnings.push('Partner release / BTSA assignment must be agreed before this option can be used.');
   if(option.capacity>5)warnings.push(option.capacity>7?'Hire trailer only after confirming physical fit and cost.':'Six or seven bikes depend on physical fit.');
   const lastAway=stops.findLast(s=>s.town!=='Durban');
   const returnLoad={bikes:lastAway?.bikes||0,cars:lastAway?.cars||0,from:lastAway?.town||'Durban'};
   const trip={id,signature,engine:'pyvrp',source,route,stops,start:stops[0].date,end:stops.at(-1).date,alternative:index>0,alternativeTo:index?null:undefined,comparison:index?'Alternative trip option':'Suggested BTSA trip',assignmentRequired,dateChanges:[],bikes:members.reduce((n,m)=>n+m.load.bikes,0),cars:members.reduce((n,m)=>n+m.load.cars,0),capacity:option.capacity,roadKm:option.distance/1000,emptyKm:option.empty/1000,returnLoad,warnings,metrics:{km:option.distance/1000,changedOrders:0},reasons:[members.length+' orders paired',option.capacity>7?'Hired trailer option':'Own trailer option','Recorded confirmed dates retained'],maps:mapLinks(stops),members};
   // Retain compatibility with saved-plan and report consumers.
   trip.legs=[{from:'Durban',to:'Durban',date:trip.start,end:trip.end,members,sequence:stops,warnings,maps:trip.maps,bikes:trip.bikes,cars:trip.cars,capacity:option.capacity,spare:0,trailer:option.capacity>7?'Hire 6m trailer':'Own trailer',source}];
   return trip;
  });
  const kept=base.accepted.filter(p=>!p.expired),savedIds=new Set(kept.flatMap(p=>p.source.map(s=>s.id)));
  const available=journeys.filter(j=>{
   const overlaps=kept.filter(p=>j.start<=p.end&&p.start<=j.end||p.source.some(s=>j.source.some(x=>x.id===s.id)));
   if(!overlaps.length)return true;
   if(overlaps.some(p=>p.source.some(s=>!j.source.some(x=>x.id===s.id))))return false;
   if(!overlaps.some(p=>p.changed||j.source.length>p.source.length))return false;
   j.replaces=overlaps.map(p=>p.id);return true;
  });
  const planned=new Set(available.filter(j=>!j.alternative).flatMap(j=>j.source.map(s=>s.id)));
  const suggested=new Set(available.flatMap(j=>j.source.map(s=>s.id)));
  base.coverage=base.coverage.map(c=>{const block=base.blocked.find(b=>b.id===c.id);if(block)return {...c,state:'review',reason:block.reason};if(['partner','unassigned','saved','later','postponed'].includes(c.state))return c;if(planned.has(c.id))return {...c,state:'proposed',reason:''};if(suggested.has(c.id))return {...c,state:'review',reason:'Included in an alternative trip option'};if(c.state==='review'&&!block)return {...c,reason:'No date-compatible place found in the tested trip options; review timing or assignment'};return c;});
  base.coverageCounts=Object.fromEntries(Object.keys(base.coverageCounts).map(s=>[s,base.coverage.filter(c=>c.state===s).length]));
  base.journeys=available;base.optimizer={engine:'PyVRP 0.14.1',state:'ready',updatedAt:new Date(now()).toISOString(),message:available.length?'Trip options refreshed from current orders':'No feasible trip option found for these dates. Review the jobs below.'};
  return base;
 }
 async function compute(request){
  pending=true;failure='';
  try{
   const all=[...request.jobs,...request.direct];
   if(all.length>40)throw Error('More than 40 open route jobs need a smaller planning batch');
   const towns=[...new Set(['Durban',...all.flatMap(j=>[j.from,j.to])])];
   if(towns.length>24)throw Error('More than 24 route towns need a smaller planning batch');
   const matrix=all.length?await roads(towns):{distances:[[0]],durations:[[0]]};
   const pack=j=>({id:j.id,from:towns.indexOf(j.from),to:towns.indexOf(j.to),bikes:j.load.bikes,cars:j.load.cars,pickup:j.collection,delivery:j.drop,conditional:j.conditional});
   const output=all.length?await solve({today:request.today,instant:request.instant,towns,distances:matrix.distances,durations:matrix.durations,jobs:request.jobs.map(pack),direct:request.direct.map(pack)}):{options:[]};
   const execution=decorate(request,output);cached={key:request.key,execution};retryAt=0;
   console.info('Dispatch PyVRP ready',JSON.stringify({bookings:execution.bookingCount,trips:execution.tripCount,options:execution.journeys.length}));onResult(execution);
  }catch(error){failure=error.message;retryAt=now()+60000;console.error('Dispatch trip optimiser held:',failure);}
  finally{pending=false;if(desired&&desired.key!==request.key&&now()>=retryAt)void compute(desired);}
 }
 function get(orders,instant,decisions=[],kept=[]){
  const request=prepare(orders,instant,decisions,kept);desired=request;
  if(cached?.key===request.key)return cached.execution;
  if(!pending&&now()>=retryAt)void compute(request);
  if(cached?.key===request.key)return cached.execution;
  request.base.journeys=[];request.base.optimizer={engine:'PyVRP 0.14.1',state:failure?'unavailable':'working',message:failure||'Building trip options from current orders. This updates automatically.'};
  return request.base;
 }
 return {get,prepare,roads,isPending:()=>pending};
}
module.exports={createOptimizer,runPython,town};
