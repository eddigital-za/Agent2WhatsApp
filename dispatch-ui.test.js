const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element{
 constructor(tag='div'){this.tag=tag;this.children=[];this.value='';this.textContent='';this.disabled=false;this.checked=false;this.hidden=false;this.classes=new Set();this.classList={toggle:(s,on)=>{if(on===undefined)on=!this.classes.has(s);if(on)this.classes.add(s);else this.classes.delete(s)},add:s=>this.classes.add(s),remove:s=>this.classes.delete(s),contains:s=>this.classes.has(s)};}
 append(...children){this.children.push(...children)}replaceChildren(...children){this.children=children;this.textContent=''}setAttribute(k,v){this[k]=v}
 querySelectorAll(selector){let items=[];for(const c of this.children){if(c instanceof Element){if(selector==='input:checked'&&c.tag==='input'&&c.checked)items.push(c);items.push(...c.querySelectorAll(selector));}}return items;}
}
const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)};
let calls=[],fail='';
const orders=[{externalId:'SLA-501',clientName:'Example A',bike:'Bike A',route:'JHB to DBN',status:'Pending',contractor:''},{externalId:'SLA-502',clientName:'Example B',bike:'Bike B',route:'CPT to JHB',status:'In Transit',contractor:'BTSA, Moto Movers'},{externalId:'M-0001',clientName:'Example C',bike:'Bike C',route:'JHB to DBN',status:'Delivered',contractor:'BTSA'}];
const context=vm.createContext({console,Set,Map,Date,document:{getElementById:$,createElement:tag=>new Element(tag),createTextNode:text=>text},fetch:async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);return {ok:body.externalId!==fail,json:async()=>body.externalId===fail?{error:'Sheet changed since loaded'}:{success:true,status:body.status||body.expected.status,contractor:body.contractors?body.contractors.join(', '):body.expected.contractor}};}});
vm.runInContext(fs.readFileSync('dispatch.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1],context);
context.fixture={orders,statuses:['Pending','In Transit','Delivered'],contractors:['BTSA','Moto Movers']};$('group').value='status';
vm.runInContext('data=fixture;render()',context);
assert.match($('intro').textContent,/2 orders/);assert.equal($('stats').children[0].children[1].textContent,'2');
vm.runInContext("setView('contractor','Moto Movers')",context);assert.match($('intro').textContent,/1 orders/);
vm.runInContext("setView('closed')",context);assert.match($('intro').textContent,/1 orders/);
vm.runInContext("setView('unassigned')",context);assert.match($('intro').textContent,/1 orders/);
vm.runInContext("setView('open');selected.add('SLA-501');selected.add('SLA-502');renderList();renderEditor()",context);assert.equal($('editorTitle').textContent,'Edit 2 orders');
assert.equal(vm.runInContext("JSON.stringify(changesFor(data.orders[1],'','add',['BTSA']))",context),JSON.stringify({externalId:'SLA-502',expected:{status:'In Transit',contractor:'BTSA, Moto Movers'}}));
assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(changesFor(data.orders[1],'','clear',[]).contractors)",context)),[]);
assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(changesFor(data.orders[1],'','replace',['BTSA']).contractors)",context)),['BTSA']);
(async()=>{
 $('editStatus').value='Delivered';$('assignment').value='unchanged';fail='SLA-502';await $('editForm').onsubmit({preventDefault(){}});
 assert.equal(calls.length,2);assert.equal(calls[0].expected.status,'Pending');assert.equal(calls[0].contractors,undefined);
 assert.equal(vm.runInContext("selected.has('SLA-501')",context),false);assert.equal(vm.runInContext("selected.has('SLA-502')",context),true);
 assert.match($('notice').textContent,/1 order saved and verified/);assert.match($('notice').textContent,/1 failed/);assert.equal($('editorTitle').textContent,'Edit order');
 vm.runInContext("setView('all')",context);$('search').value='Bike B';$('search').oninput();assert.match($('intro').textContent,/1 orders/);assert.equal(vm.runInContext('selected.size',context),0);
 console.log('PASS: summaries, category filters, contractor membership, multi-selection, add/replace/clear, unchanged fields, partial batch failures, search and selection reset. Fake orders only.');
})().catch(e=>{console.error(e);process.exitCode=1});
