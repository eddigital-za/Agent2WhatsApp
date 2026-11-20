'use strict';
const assert=require('node:assert/strict');
const {prepare}=require('./prepare-workspace.cjs');
const date='2026-11-20';
const order=(n,extra={})=>({externalId:'PRIVATE-'+n,clientName:'PRIVATE CUSTOMER',
phone:'PRIVATE PHONE',collectionAddress:'PRIVATE STREET',deliveryAddress:'PRIVATE STREET',
bike:'Honda',status:'New Order',route:'DBN to JHB',contractor:'BTSA',syncState:'synced',...extra});
const eta=date=>({date,confidence:'confirmed',precision:'day'});
const data={orders:Array.from({length:13},(_,i)=>order(i))};
data.orders[0].returnTrip={status:'New Order',contractor:'BTSA'};
data.orders[1]={...data.orders[1],route:'JHB to Hoedspruit',bike:'BAJAJ Qute',collection:eta('2026-11-24'),delivery:eta('2026-11-25')};
data.orders[2]={...data.orders[2],route:'Montana to Malelane',collection:eta('2026-11-24'),delivery:eta('2026-11-25')};
data.orders[3]={...data.orders[3],route:'DBN to CPT',contractor:'BTSA, Cheetah Express'};
data.orders[4].status='In Transit';
data.orders[5].bike='Tuk Tuk';
data.orders[6].collection=eta('2026-12-20');
data.orders[7].route='Unknown to Unknown';
const before=JSON.stringify(data),out=prepare(data,date);
assert.equal(JSON.stringify(data),before);
assert.equal(out.bookingCount,13);assert.equal(out.tripCount,14);assert.equal(out.coverage.length,14);
assert.ok(!JSON.stringify(out).includes('PRIVATE'));
assert.ok(out.candidates.some(c=>c.from==='Johannesburg'&&c.to==='Hoedspruit'&&c.cars===1));
assert.ok(out.candidates.some(c=>c.to==='Malelane'&&c.pickupDate==='2026-11-24'));
assert.ok(out.candidates.some(c=>c.partnerHandover&&c.conditional&&c.to==='Johannesburg'));
assert.ok(out.coverage.some(c=>c.state==='review'));
assert.throws(()=>prepare({orders:[order(1),order(1)]},date),/duplicate/);
assert.throws(()=>prepare({},date),/workspace/);
console.log('PASS: 13 bookings / 14 trips accounted for; return reversal, date preservation, mixed handover conditions, private-field exclusion and input immutability.');
