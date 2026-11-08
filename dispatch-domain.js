'use strict';
const STATUSES=['New Order','Pending','Collected','In Transit','Paused','Delivered','Cancelled','Duplicate'];
const closed=s=>['Delivered','Cancelled','Duplicate'].includes(s);
const canonical=value=>{const s=String(value||'').trim().toUpperCase().replace(/\s/g,'');let m=s.match(/^SL(?:A)?-?(\d+)$/);if(m)return 'SLA-'+Number(m[1]);m=s.match(/^M-?0*(\d+)$/);return m?'M-'+String(Number(m[1])).padStart(4,'0'):null;};
const refs=text=>[...new Set([...String(text||'').matchAll(/\b(?:SL(?:A)?[ -]?\d+|M-?\d+)\b/gi)].map(m=>canonical(m[0])))];
function segments(text){const body=String(text||'');const hits=[...body.matchAll(/\b(?:SL(?:A)?[ -]?\d+|M-?\d+)\b/gi)];if(!hits.length)return [{ref:null,text:body}];return hits.map((m,i)=>({ref:canonical(m[0]),text:body.slice(m.index,hits[i+1]?.index||body.length).trim()}));}
const localDay=d=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Johannesburg',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(d));
const addDay=(s,n)=>new Date(new Date(s+'T12:00:00+02:00').getTime()+n*86400000).toISOString().slice(0,10);
function when(text,base=new Date()){
 const t=String(text||'').toLowerCase().replace(/(\d)(?:st|nd|rd|th)\b/g,'$1').replace(/\bof\s+(?=(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/g,'');if(!t||/\b(not (?:yet )?confirmed|to be confirmed|tbc|unknown)\b/.test(t))return null;
 const today=localDay(base),year=today.slice(0,4);let day;
 const iso=t.match(/\b(20\d{2}-\d{2}-\d{2})\b/),named=t.match(/\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(20\d{2}))?\b/),za=t.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](20\d{2}))?\b/);
 if(iso)day=iso[1];else if(named){const month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(named[2].slice(0,3))+1;day=`${named[3]||year}-${String(month).padStart(2,'0')}-${named[1].padStart(2,'0')}`;}else if(za)day=`${za[3]||year}-${za[2].padStart(2,'0')}-${za[1].padStart(2,'0')}`;
 else if(/\byesterday\b/.test(t))day=addDay(today,-1);else if(/\btomorrow\b/.test(t))day=addDay(today,1);else if(/\b(today|this afternoon|this morning|later today)\b/.test(t))day=today;
 else{const days=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];const index=days.findIndex(x=>t.includes(x));if(index>=0){let diff=(index-new Date(today+'T12:00:00+02:00').getUTCDay()+7)%7;if(!diff)diff=7;day=addDay(today,diff);}}
 if(!day)return null;const valid=new Date(day+'T12:00:00+02:00');if(!Number.isFinite(valid.getTime())||localDay(valid)!==day)throw Error('Invalid date: '+day);
 const time=t.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);let precision=time?'minute':/\bweek of\b/.test(t)?'week':/\b(morning|afternoon|evening)\b/.test(t)?'window':'day';
 const confidence=/\b(approximately|approx|expected|estimated|estimate|maybe|tentative|provisional|week of|later today)\b/.test(t)?'expected':'confirmed';
 return {date:day,time:time?time[1].padStart(2,'0')+':'+time[2]:'',precision,window:precision==='window'?(t.match(/morning|afternoon|evening/)||[])[0]:'',confidence};
}
function stageText(text,stage){const words=stage==='collection'?'collect(?:ion|ed)?|pick[ -]?up|fetch':'deliver(?:y|ed)?|drop[ -]?off';const all='collect(?:ion|ed)?|pick[ -]?up|fetch|deliver(?:y|ed)?|drop[ -]?off|handover|hand[ -]?over';return String(text).match(new RegExp('\\b(?:'+words+')\\b[\\s\\S]*?(?=\\b(?:'+all+')\\b|$)','i'))?.[0]||'';}
function contractorNames(text,available){const t=String(text||'').toLowerCase().replace(/cheeta\b/g,'cheetah').replace(/dj bike towing/g,'dj bike transport');return available.filter(name=>{const values=[name.toLowerCase(),name.toLowerCase().split(' - ').pop()];if(name==='Cheetah Express')values.push('cheetah');return values.some(v=>new RegExp('\\b'+v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i').test(t));});}
function interpret(text,available,base=new Date()){
 const t=String(text||'');const out={};const c=stageText(t,'collection'),d=stageText(t,'delivery');const collection=when(c,base),delivery=when(d,base);
 if(collection)out.collection=collection;if(delivery)out.delivery=delivery;
 if(/\b(delivered|complete|completed|done)\b/i.test(t)&&!(/\b(?:handover|handed over|depot|taken delivery)\b/i.test(t)&&!/^\s*(?:SL(?:A)?[ -]?\d+|M-?\d+)?\s*[-:]?\s*(?:delivered|complete)/i.test(t)))out.status='Delivered';
 else if(/\b(cancelled|canceled|cancel)\b/i.test(t))out.status='Cancelled';else if(/\bin[ -]?transit\b/i.test(t))out.status='In Transit';else if(/\bcollected\b/i.test(t))out.status='Collected';else if(/\bpaused\b/i.test(t))out.status='Paused';
 if(out.status==='Delivered')out.actualDelivery=when(d,base)||{date:localDay(base),time:'',precision:'day',confidence:'confirmed'};
 if(/\bcollected\b/i.test(c))out.actualCollection=collection||{date:localDay(base),time:'',precision:'day',confidence:'confirmed'};
 const names=contractorNames(t,available);if(names.length)out.contractor=names.join(', ');
 if(/\b(depot|handover|hand[ -]?over|taken delivery|\bleg\b)\b/i.test(t)){out.legNote=t;out.needsLegReview=true;}
 return out;
}
function reviewDue(deliveredAt,replyAt,now,config){if(!config?.reviewText||!config?.reviewLink||!config?.eveningCutoff||!config?.morningTime)return null;const trigger=replyAt?new Date(replyAt):new Date(new Date(deliveredAt).getTime()+30*60000);let day=localDay(trigger);const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Johannesburg',hour:'2-digit',minute:'2-digit',hour12:false}).format(trigger);if(parts>=config.eveningCutoff)day=addDay(day,1);if(parts>=config.eveningCutoff||parts<config.morningTime)return new Date(day+'T'+config.morningTime+':00+02:00').toISOString();return trigger.toISOString();}
function customerGreeting(o){
 const first=String(o.clientName||'').trim().split(/\s+/)[0];
 const name=/^\p{L}[\p{L}'’-]{0,39}$/u.test(first)?first[0].toLocaleUpperCase()+(first===first.toLocaleUpperCase()?first.slice(1).toLocaleLowerCase():first.slice(1)):'';
 return name?'Hi '+name+'! ':'Hi! ';
}
const collectionComplete=o=>!!o.actualCollection||['Collected','In Transit','Delivered'].includes(o.status);
function customerDate(eta){
 const date=new Date(eta.date+'T12:00:00+02:00');
 const label=new Intl.DateTimeFormat('en-ZA',{weekday:'long',day:'numeric',month:'long',timeZone:'Africa/Johannesburg'}).format(date);
 return label+(eta.time?' at '+eta.time:eta.window?' ('+eta.window+')':'');
}
module.exports={customerGreeting,collectionComplete,customerDate,STATUSES,closed,canonical,refs,segments,localDay,when,stageText,contractorNames,interpret,reviewDue};
