'use strict';
const crypto=require('node:crypto'),{localDay,reviewDue,closed}=require('./dispatch-domain');
const phone=v=>{let s=String(v||'').replace(/\D/g,'');if(/^0\d{9}$/.test(s))s='27'+s.slice(1);return /^\d{9,15}$/.test(s)?s:null;};
function installCommunications({app,auth,db,operations,sendCustomer,sendApproval,now=()=>new Date().toISOString()}){
 db.exec(`CREATE TABLE IF NOT EXISTS dispatch_deliveries(id TEXT PRIMARY KEY,message_id TEXT NOT NULL UNIQUE,ref TEXT NOT NULL,phone TEXT NOT NULL,sent_at TEXT NOT NULL,parts TEXT NOT NULL,reply_at TEXT,review_state TEXT NOT NULL DEFAULT 'waiting',error TEXT);
 CREATE TABLE IF NOT EXISTS dispatch_approval_quotes(quote TEXT PRIMARY KEY,message_id TEXT NOT NULL UNIQUE);
 CREATE TABLE IF NOT EXISTS dispatch_send_parts(message_id TEXT NOT NULL,part INTEGER NOT NULL,whatsapp_id TEXT NOT NULL,sent_at TEXT NOT NULL,PRIMARY KEY(message_id,part));`);
 db.prepare("UPDATE dispatch_messages SET state='uncertain',reason='Send was interrupted. Reconcile before retrying.' WHERE state='sending'").run();
 const config=()=>JSON.parse(db.prepare('SELECT data FROM dispatch_settings WHERE id=1').get().data);
 let sending=false;
 const approvalStart=now();
 // Replace the requested draft only if its original text is still awaiting approval.
 // Keep the original record so a reply to the old preview cannot send it.
 if(config().autoSend!==true){
  db.exec('BEGIN IMMEDIATE');
  try{
   const old=db.prepare("SELECT id FROM dispatch_messages WHERE ref='SLA-526' AND kind='Collected' AND state='awaiting_approval' AND text IN (?,?)").all('Your motorcycle has been collected successfully.','Hi! We’ve picked up your Honda CBR. Here are the photos we took at collection so you have a record of its condition. We’ll keep you posted on the trip to Johannesburg. Thanks, BTSA');
   if(old.length===1){
    const id=old[0].id;
    db.prepare("UPDATE dispatch_messages SET state='held',reason='Replaced with a new preview. Approve the replacement instead.' WHERE id=?").run(id);
    db.prepare('INSERT INTO dispatch_messages VALUES(?,?,?,?,?,?,?)').run(id+'-first-name','SLA-526','Collected','awaiting_approval','Hi Johny! We’ve picked up your Honda CBR. Here are the photos we took at collection so you have a record of its condition. We’ll keep you posted on the trip to Johannesburg. Thanks, BTSA',approvalStart,'Revised copy. Confirm before sending with all matched photos.');
   }
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 function hours(c,at=now()){if(!c.eveningCutoff||!c.morningTime)return false;const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Johannesburg',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at));return time>=c.morningTime&&time<c.eveningCutoff;}
 function blocked(o,m){if(!o||o.duplicateOf||o.status==='Cancelled'||o.status==='Duplicate')return 'Order is cancelled or duplicate.';if(o.complaintOpen)return 'Customer concern remains unresolved.';if(!phone(o.phone))return 'Confirm the booking customer’s WhatsApp number first.';if(m.kind==='Collected'&&!['Collected','In Transit','Delivered'].includes(o.status))return 'Collection is not confirmed.';if(m.kind==='In Transit'&&o.status!=='In Transit')return 'Order is no longer in transit.';if(m.kind==='Collected'&&o.status==='Delivered')return 'Collection update is superseded by completed delivery.';if(m.kind==='Delivered'&&o.status!=='Delivered')return 'Delivery is not confirmed.';if(['Collection reminder','Collection scheduled'].includes(m.kind)&&(closed(o.status)||['Collected','In Transit'].includes(o.status)||o.actualCollection||o.collection?.confidence!=='confirmed'||o.collection.date<localDay(now())))return 'Collection ETA is missing, stale or no longer applicable.';if(m.kind==='Delivery update'&&(closed(o.status)||o.delivery?.confidence!=='confirmed'||o.delivery.date<localDay(now())))return 'Delivery ETA is missing, stale or no longer applicable.';return '';}
 async function send(id){if(sending)throw Object.assign(Error('Another customer message is being sent. Try again shortly.'),{status:409});const m=db.prepare('SELECT * FROM dispatch_messages WHERE id=?').get(id);if(!m)throw Object.assign(Error('Message not found'),{status:404});if(m.state==='sent')return {alreadySent:true};if(m.state!=='awaiting_approval')throw Object.assign(Error('This message is held or its send outcome needs review.'),{status:409});const c=config(),o=operations.get(m.ref);if(!hours(c))throw Object.assign(Error('Set customer sending hours; send only within those hours.'),{status:409});const problem=blocked(o,m);if(problem)throw Object.assign(Error(problem),{status:409});const legacy=db.prepare('SELECT id FROM orders WHERE external_id=?').get(o.externalId);const stage=m.kind==='Collected'?'collection':m.kind==='Delivered'?'delivery':null;const proofs=stage&&legacy?db.prepare("SELECT * FROM proofs WHERE order_id=? AND stage=? AND status='confirmed' ORDER BY id").all(legacy.id,stage):[];
  if(stage&&!proofs.length)throw Object.assign(Error('Attach and confirm the '+stage+' photos before sending this update.'),{status:409});
  sending=true;db.prepare("UPDATE dispatch_messages SET state='sending',reason='Sending; outcome will be recorded.' WHERE id=?").run(id);
  try{const parts=await sendCustomer({phone:phone(o.phone),text:m.text,proofs,onPart:(part,waId)=>{db.prepare('INSERT INTO dispatch_send_parts VALUES(?,?,?,?)').run(id,part,String(waId||''),now());}});const at=now();db.prepare("UPDATE dispatch_messages SET state='sent',reason=? WHERE id=?").run('Sent '+at,id);operations.emit(o.externalId,'customer-whatsapp','customer_message_sent',{messageId:id,kind:m.kind,parts});if(m.kind==='Delivered')db.prepare('INSERT OR IGNORE INTO dispatch_deliveries(id,message_id,ref,phone,sent_at,parts) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),id,o.externalId,phone(o.phone),at,JSON.stringify(parts));return {sent:true};
  }catch(e){db.prepare("UPDATE dispatch_messages SET state='uncertain',reason=? WHERE id=?").run('Send outcome needs reconciliation: '+e.message,id);operations.issue(o.externalId,'Customer message outcome needs reconciliation. Do not resend automatically.','message-'+id);throw e;}finally{sending=false;}
 }
 function noteReply(number,body,eventKey){const normalized=phone(number);if(!normalized)return;const deliveries=db.prepare("SELECT * FROM dispatch_deliveries WHERE phone=? AND review_state IN ('waiting','ready','queued') ORDER BY sent_at DESC").all(normalized);for(const d of deliveries){const at=now();const negative=/\b(damag\w*|scratch\w*|broken|problem|issue|complain\w*|missing|stop|unsubscribe|do not contact|not received|not delivered|unhappy|wrong|late)\b/i.test(body);const positive=/^(?:(?:thank(?:s| you)|thanks so much|thank you so much|great|perfect|awesome|all good|received|got it|much appreciated|lekker|shot|cheers|ok|okay|yes)[\s!.,🙏👍🏼✅😊🙂❤❤️]*)+$/i.test(String(body||'').trim());const state=negative?'complaint':positive&&deliveries.length===1?'ready':'reply_review';db.prepare('UPDATE dispatch_deliveries SET reply_at=?,review_state=? WHERE id=?').run(at,state,d.id);operations.emit(d.ref,'customer-whatsapp','customer_replied',{text:String(body||'').slice(0,4000),reviewState:state},eventKey+'-'+d.id);if(state!=='ready'){db.prepare("UPDATE dispatch_messages SET state='held',reason='Customer reply needs review' WHERE id=? AND state='awaiting_approval'").run('review-'+d.id);operations.issue(d.ref,negative?'Customer delivery concern: review request held.':'Customer reply needs review before asking for a review.','reply-'+d.id);const o=operations.get(d.ref);if(o)operations.save({...o,complaintOpen:negative||o.complaintOpen},o.syncState);}}}
 async function approveReply(ids,body){
  const action=String(body||'').trim().toLowerCase();
  if(!['approve','hold'].includes(action))return null;
  for(const id of ids){
   const matches=db.prepare("SELECT message_id FROM dispatch_approval_quotes WHERE quote=? OR substr(quote,-length(?))=?").all(id,'_'+id,'_'+id);
   if(matches.length!==1)continue;
   const key=matches[0].message_id;
   if(action==='hold'){const result=db.prepare("UPDATE dispatch_messages SET state='held',reason='Held in WhatsApp' WHERE id=? AND state='awaiting_approval'").run(key);return result.changes?'Customer update held.':'This update is no longer awaiting approval.';}
   try{const result=await send(key);return result.alreadySent?'Customer update was already sent.':'Customer update sent.';}catch(e){return e.message;}
  }return null;
 }
 async function tick(){const c=config(),withinHours=hours(c);
 if(withinHours){
 for(const o of operations.all()){if(closed(o.status)||o.actualCollection||o.collection?.confidence!=='confirmed'||o.collection.precision==='week'||o.collection.date!==localDay(now()))continue;const id='collection-reminder-'+o.externalId+'-'+o.collection.date;db.prepare('INSERT OR IGNORE INTO dispatch_messages VALUES(?,?,?,?,?,?,?)').run(id,o.externalId,'Collection reminder','awaiting_approval','A reminder that your motorcycle collection is scheduled for '+o.collection.date+(o.collection.time?' at '+o.collection.time:'')+'. We will keep you updated.',now(),'Confirmed collection date; customer recipient must be verified.');}
for(const d of db.prepare("SELECT * FROM dispatch_deliveries WHERE review_state IN ('waiting','ready')").all()){const o=operations.get(d.ref);if(!o||o.complaintOpen||o.status!=='Delivered')continue;const due=reviewDue(d.sent_at,d.reply_at,now(),c);if(!due||due>now())continue;const id='review-'+d.id;const content=c.reviewText+'\n'+c.reviewLink;db.prepare('INSERT OR IGNORE INTO dispatch_messages VALUES(?,?,?,?,?,?,?)').run(id,d.ref,'Review request','awaiting_approval',content,now(),'Delivery message and photos sent; review timing satisfied.');db.prepare("UPDATE dispatch_deliveries SET review_state='queued' WHERE id=?").run(d.id);}
 }
  // Customer automation is opt-in; before configuration, every message stays a draft.
  if(c.autoSend!==true){
   if(sendApproval)for(const m of db.prepare("SELECT * FROM dispatch_messages WHERE state='awaiting_approval' AND created_at>=? AND id NOT IN (SELECT message_id FROM dispatch_approval_quotes) ORDER BY created_at").all(approvalStart)){
    const o=operations.get(m.ref);if(blocked(o,m)||o.syncState!=='synced')continue;
    const stage=m.kind==='Collected'?'collection':m.kind==='Delivered'?'delivery':null;
    const photoCount=stage?operations.details(o.externalId).proofs.filter(p=>p.stage===stage&&p.status==='confirmed').length:0;
    if(stage&&!photoCount)continue;
    const result=await sendApproval('Ready for your review: '+o.bike+' ('+o.externalId+')\n'+m.kind+(photoCount?' with '+photoCount+' '+(photoCount===1?'photo':'photos'):'')+'\n\nHere’s what the customer will get:\n'+m.text+'\n\nReply APPROVE to send '+(photoCount?'the message and photos':'the message')+', or HOLD to pause it.','dispatch-approval-'+m.id);
    if(result.messageId)db.prepare('INSERT OR IGNORE INTO dispatch_approval_quotes VALUES(?,?)').run(result.messageId,m.id);
   }return;
  }if(!withinHours)return;for(const m of db.prepare("SELECT * FROM dispatch_messages WHERE state='awaiting_approval' ORDER BY created_at LIMIT 10").all()){const o=operations.get(m.ref);if(m.created_at<(c.autoEnabledAt||now())||blocked(o,m))continue;try{await send(m.id);}catch(e){if(e.status!==409)console.error('Customer message held:',e.message);}}
 }
 const route=(method,path,fn)=>app[method](path,auth,async(req,res)=>{try{res.json(await fn(req));}catch(e){res.status(e.status||500).json({error:e.message});}});
 route('post','/dispatch/communication-settings',req=>{const p=req.body||{},c=config();for(const k of ['reviewText','reviewLink','eveningCutoff','morningTime'])if(p[k]!==undefined)c[k]=String(p[k]).trim().slice(0,k==='reviewText'?3000:500);for(const k of ['morningTime','eveningCutoff'])if(c[k]&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(c[k]))throw Object.assign(Error('Invalid customer sending hours'),{status:400});if(c.morningTime&&c.eveningCutoff&&c.morningTime>=c.eveningCutoff)throw Object.assign(Error('Morning time must precede evening cutoff'),{status:400});if(c.reviewLink&&!/^https:\/\/[^\s]+$/.test(c.reviewLink))throw Object.assign(Error('Review link must be an HTTPS URL'),{status:400});if(p.autoSend!==undefined){if(p.autoSend===true&&c.autoSend!==true)c.autoEnabledAt=now();c.autoSend=p.autoSend===true;}db.prepare('UPDATE dispatch_settings SET data=? WHERE id=1').run(JSON.stringify(c));operations.emit(null,'dashboard','communication_settings_updated',{...c});return c;});
 route('post','/dispatch/messages/:id/send',req=>send(req.params.id));
 route('post','/dispatch/messages/:id/hold',req=>{db.prepare("UPDATE dispatch_messages SET state='held',reason='Held by dispatcher' WHERE id=? AND state='awaiting_approval'").run(req.params.id);return {held:true};});
 route('post','/dispatch/customer-concern/:ref',req=>{const o=operations.get(req.params.ref);if(!o)throw Object.assign(Error('Order not found'),{status:404});if(Number(req.body.version)!==o.version)throw Object.assign(Error('Order changed. Refresh first.'),{status:409});operations.save({...o,complaintOpen:req.body.open!==false},o.syncState);operations.emit(o.externalId,'dashboard','customer_concern_updated',{open:req.body.open!==false});return {success:true};});
 return {send,tick,approveReply,noteReply,config,hours,blocked};
}
module.exports={installCommunications,phone};
