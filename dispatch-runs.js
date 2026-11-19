'use strict';
const WOODHAVEN='Woodhaven, Durban, South Africa';
const POMONA='Cheetah Express Depot, Pomona, Kempton Park, South Africa';
function region(value){
 const text=String(value||'').toLowerCase();
 if(/\b(dbn|durban|ballito|pmb|pietermaritzburg|woodhaven|queensburgh|pinetown|kzn)\b/.test(text))return 'Durban';
 if(/\b(jhb|johannesburg|joburg|pomona|kempton|randburg|sandton|edenvale|fourways|gauteng)\b/.test(text))return 'Johannesburg';
 return '';
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
function vehicle(job){
 const text=String(job.bike||job.label||'');
 const count=job.quantity===null||job.quantity===undefined||String(job.quantity).trim()===''?1:Number(job.quantity);
 if(!Number.isInteger(count)||count<1||/\b\d+\s*[x×]\s*/i.test(text))return null;
 if(/\b(car|beetle|qute|bakkie|sedan|suv)\b/i.test(text))return {cars:count,bikes:0};
 // Unrecognised goods must be checked rather than counted as a motorcycle.
 if(/\b(boat|trailer|caravan|furniture|quad|tuk\s*tuk)\b/i.test(text))return null;
 return {cars:0,bikes:count};
}
function buildRuns(jobs,today){
 const buckets=new Map(),blocked=[];
 for(const job of jobs){
  if(!job.own||job.decision==='snoozed')continue;
  const pickup=job.stops.find(s=>s.kind==='Pickup'),drop=job.stops.at(-1);
  const parts=String(job.route||'').split(/\s+(?:to|→)\s+/i);
  const from=region(parts[0]),to=region(parts.at(-1));
  let why='';
  if(job.reasons.length)why=job.reasons.join(' · ');
  else if(!pickup)why='Already collected: confirm where it is before adding it to a new load';
  else if(pickup.date<today)why='Pickup is overdue: confirm whether it was collected';
  else if(parts.length!==2||!from||!to||from===to)why='Route needs a separate run plan';
  const load=vehicle(job);
  if(!why&&!load)why='Check vehicle size and quantity before loading';
  if(why){blocked.push({id:job.id,label:job.label,reason:why});continue;}
  const key=[from,to,pickup.date,drop.date].join('|');
  if(!buckets.has(key))buckets.set(key,{from,to,date:pickup.date,end:drop.date,jobs:[]});
  buckets.get(key).jobs.push({...job,load});
 }
 const runs=[];
 for(const bucket of buckets.values()){
  // ponytail: corridor/date grouping, not road optimisation; Maps supplies driving directions.
  const waiting=bucket.jobs.sort((a,b)=>(a.stops.at(-1).date+(a.stops.at(-1).time||'23:59')).localeCompare(b.stops.at(-1).date+(b.stops.at(-1).time||'23:59'))||a.label.localeCompare(b.label));
  while(waiting.length){
   const members=[];let bikes=0,cars=0;
   for(let i=0;i<waiting.length;){
    const job=waiting[i],nextCars=cars+job.load.cars,nextBikes=bikes+job.load.bikes;
    if(nextCars<=1&&nextBikes<=(nextCars?3:11)){members.push(job);cars=nextCars;bikes=nextBikes;waiting.splice(i,1);}else i++;
   }
   if(!members.length){const job=waiting.shift();blocked.push({id:job.id,label:job.label,reason:'This booking exceeds one load. Split the vehicle quantity before planning.'});continue;}
   const steps=[];
   // Load all bikes before the long-distance offloads; reject fixed times that contradict this.
   for(const kind of ['Pickup','Handover','Drop-off']){
    const stops=members.flatMap(job=>job.stops.filter(stop=>stop.kind===kind).map(stop=>({...stop,label:job.label,jobId:job.id,load:job.load})));
    stops.sort((a,b)=>(a.date+(a.time||'00:00')).localeCompare(b.date+(b.time||'00:00'))||a.address.localeCompare(b.address));
    steps.push(...stops);
   }
   let lower='',valid=true;
   for(const step of steps){
    const windows={morning:['06:00','11:59'],afternoon:['12:00','17:59'],evening:['18:00','23:59']};
    const bounds=step.time?[step.time,step.time]:windows[String(step.window||'').toLowerCase()]||['00:00','23:59'];
    if(lower>step.date+bounds[1])valid=false;
    if(lower<step.date+bounds[0])lower=step.date+bounds[0];
   }
   if(!valid){for(const job of members)blocked.push({id:job.id,label:job.label,reason:'Fixed stop times conflict with loading before offloading. Review these dates and times.'});continue;}
   const origin=bucket.from==='Durban'?WOODHAVEN:POMONA;
   const finish=bucket.to==='Johannesburg'?POMONA:WOODHAVEN;
   const sequence=[{kind:'Start',address:origin,date:bucket.date},...steps,{kind:'Finish',address:finish,date:bucket.end}];
   runs.push({...bucket,jobs:members.map(j=>j.id),bikes,cars,sequence,maps:mapLinks(sequence),trailer:cars?'Car + bikes':bikes>7?'Hire 6m trailer':bikes>5?'Own trailer: check fit':'Own trailer',notes:[cars?'Maximum one car and three bikes.':bikes>7?'Hire suggested for this volume. Planned below your 11–12 bike upper range.':bikes>5?'Six or seven bikes depends on their size. Check fit before committing.':'Own trailer planned at five bikes or fewer.',bucket.from==='Johannesburg'?'Starts at Pomona. Get to Johannesburg first or pair with a Durban outbound run.':'Starts at Woodhaven.', 'Stop order follows dates and loading stages. Check driving time in Maps.']});
  }
 }
 runs.sort((a,b)=>a.date.localeCompare(b.date)||a.from.localeCompare(b.from));
 const paired=new Set();
 for(let i=0;i<runs.length;i++){
  const out=runs[i];if(out.from!=='Durban'||paired.has(i))continue;
  const backIndex=runs.findIndex((back,k)=>k!==i&&!paired.has(k)&&back.from===out.to&&back.to===out.from&&back.date>out.end);
  if(backIndex>=0){out.returnIndex=backIndex;runs[backIndex].outboundIndex=i;paired.add(i);paired.add(backIndex);}
 }
 return {origin:WOODHAVEN,handover:POMONA,runs,blocked};
}
module.exports={buildRuns,mapLinks};
