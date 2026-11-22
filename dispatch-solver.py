"""Bounded, offline PyVRP worker. stdin/stdout JSON only; no application access."""
import itertools
import json
import math
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pyvrp import Model
from pyvrp.stop import MaxRuntime

DAY=86400
SERVICE=1200
DRIVE=8*3600
OPEN=8*3600
CLOSE=18*3600

def optimise(data, budget=24):
    started=time.monotonic()
    deadline=started+budget*.75
    towns=data['towns'];dist=data['distances'];duration=data['durations']
    base=datetime.fromisoformat(data['today'])
    horizon=15*DAY-1
    current=datetime.fromisoformat(data['instant'].replace('Z','+00:00')).astimezone(timezone(timedelta(hours=2)))
    current_seconds=max(0,int((current.replace(tzinfo=None)-base).total_seconds()))
    if len(towns)>24 or len(data['jobs'])>40:raise ValueError('Problem size limit')
    n=len(towns)
    assert all(len(m)==n and all(len(row)==n and all(isinstance(v,(int,float)) and math.isfinite(v) and v>=0 for v in row) for row in m) for m in (dist,duration))
    dist=[[round(v) for v in row] for row in dist]
    duration=[[math.ceil(v) for v in row] for row in duration]
    assert towns[0]=='Durban'
    for matrix in (dist,duration):
        for i in range(n):matrix[i][i]=0

    def bounds(eta):
        if not eta or not eta.get('date') or eta.get('confidence')!='confirmed' or eta.get('precision')=='week':
            return current_seconds,horizon
        day=(datetime.fromisoformat(eta['date'])-base).days*DAY
        early,late=OPEN,CLOSE-SERVICE
        if eta.get('time'):
            hour,minute=map(int,eta['time'].split(':')[:2]);early=late=hour*3600+minute*60
        elif eta.get('window','').lower() in ('morning','afternoon'):
            early,late=(OPEN,12*3600-SERVICE) if eta['window'].lower()=='morning' else (12*3600,CLOSE-SERVICE)
        return max(current_seconds,day+early),min(horizon,day+late)

    def next_day(clock):return (clock//DAY+1)*DAY+OPEN

    def schedule(actions,jobs,capacity):
        # Unload flexible cargo on its first existing destination visit.
        aboard=set();done=set();ordered=[]
        for pickup,i in actions:
            if not pickup and i in done:continue
            ordered.append((pickup,i))
            if pickup:aboard.add(i)
            else:
                if i not in aboard:return None
                aboard.remove(i);done.add(i)
            town=jobs[i]['from'] if pickup else jobs[i]['to']
            for cargo in sorted(aboard):
                if jobs[cargo]['to']==town and not jobs[cargo].get('delivery'):
                    ordered.append((False,cargo));aboard.remove(cargo);done.add(cargo)
        if aboard or len(ordered)!=len(actions):return None
        # Try future departure days automatically; retain the latest feasible one.
        earliest_day=current_seconds//DAY
        plans=[]
        for departure_day in range(earliest_day,15):
            clock=max(departure_day*DAY+OPEN,current_seconds)
            if clock%DAY>=CLOSE:continue
            departure=clock;drive=continuous=0;active_day=clock//DAY;last=0
            cargo=set();visited=set();metres=empty=0;stops=[];valid=True
            for pickup,i in ordered+[(None,None)]:
                target=0 if i is None else jobs[i]['from'] if pickup else jobs[i]['to']
                travel=duration[last][target]
                metres+=dist[last][target]
                if not cargo:empty+=dist[last][target]
                while travel:
                    if clock//DAY!=active_day:drive=continuous=0;active_day=clock//DAY
                    clock=max(clock,clock//DAY*DAY+OPEN)
                    room=min(DRIVE-drive,CLOSE-clock%DAY)
                    if room<=0:clock=next_day(clock);continue
                    if continuous>=4*3600:clock+=1800;continuous=0;continue
                    take=min(travel,room,4*3600-continuous)
                    clock+=take;drive+=take;continuous+=take;travel-=take
                if i is None:
                    if clock>horizon:valid=False
                    if cargo:valid=False
                    stops.append({'kind':'Return','town':towns[0],'at':clock,'bikes':0,'cars':0})
                    break
                job=jobs[i];lo,hi=bounds(job.get('pickup' if pickup else 'delivery'))
                if clock<lo:
                    if lo-clock>=1800:continuous=0
                    clock=lo
                if clock//DAY!=active_day:drive=continuous=0;active_day=clock//DAY
                clock=max(clock,clock//DAY*DAY+OPEN)
                if clock%DAY+SERVICE>CLOSE:clock=next_day(clock);drive=continuous=0;active_day=clock//DAY
                if clock>hi or lo>hi:valid=False;break
                if pickup:
                    if i in cargo or i in visited:valid=False;break
                    cargo.add(i)
                else:
                    if i not in cargo:valid=False;break
                    cargo.remove(i);visited.add(i)
                bikes=sum(jobs[x]['bikes'] for x in cargo);cars=sum(jobs[x]['cars'] for x in cargo)
                if cars>1 or bikes>(3 if cars else capacity):valid=False;break
                stops.append({'kind':'Pickup' if pickup else 'Drop-off','id':job['id'],'town':towns[target],'at':clock,'bikes':bikes,'cars':cars})
                clock+=SERVICE;continuous=0 if SERVICE>=1800 else continuous;last=target
            if valid and len(visited)*2==len(ordered):
                def serial(s):
                    d=base+timedelta(seconds=s.pop('at'));return {**s,'date':d.date().isoformat(),'time':d.strftime('%H:%M')}
                start={'kind':'Start','town':'Durban','at':departure,'bikes':0,'cars':0}
                plans.append({'jobs':[jobs[i]['id'] for i in sorted(visited)],'stops':[serial(start)]+[serial(s) for s in stops],
                              'distance':metres,'empty':empty,'capacity':capacity})
        return plans[-1] if plans else None

    def solve(jobs,capacity,bias=None):
        if not jobs or time.monotonic()>=deadline:return None
        model=Model();loc=[model.add_location(i,0,name=t) for i,t in enumerate(towns)]
        model.add_depot(loc[0],tw_late=horizon)
        model.add_vehicle_type(1,capacity=[capacity,1,max(7,capacity)],tw_early=current_seconds,tw_late=horizon)
        packed=[]
        for job in jobs:
            p,d=bounds(job.get('pickup')),bounds(job.get('delivery'))
            if bias and job['id']==bias[0]:d=(d[0],min(d[1],d[0]//DAY*DAY+10*3600))
            if p[0]>p[1] or d[0]>d[1] or d[1]<p[0]:continue
            amount=[job['bikes'],job['cars'],job['bikes']+job['cars']*(max(7,capacity)-3)]
            model.add_shipment(loc[job['from']],loc[job['to']],pickup_tw_early=p[0],pickup_tw_late=p[1],
                delivery_tw_early=d[0],delivery_tw_late=d[1],pickup_service_duration=SERVICE,delivery_service_duration=SERVICE,
                amount=amount,required=False,prize=100000000 if not job['conditional'] else 20000000)
            packed.append(job)
        if not packed:return None
        for i,a in enumerate(loc):
            for j,b in enumerate(loc):model.add_edge(a,b,distance=dist[i][j],duration=duration[i][j])
        result=model.solve(MaxRuntime(min(1.3,max(.1,deadline-time.monotonic()))),seed=42,display=False)
        if not result.is_feasible() or len(result.best.routes())!=1:return None
        route=result.best.routes()[0]
        actions=[(k=='L',int(i)) for k,i in re.findall(r'([LU])(\d+)',str(route))]
        seen=set();picked=set()
        for pickup,i in actions:
            if i>=len(packed):return None
            if pickup:
                if i in picked:return None
                picked.add(i)
            else:
                if i not in picked or i in seen:return None
                seen.add(i)
        if picked!=seen:return None
        option=schedule(actions,packed,capacity)
        if option:
            option['own']=sum(not j['conditional'] for j in packed if j['id'] in option['jobs'])
            option['conditional']=sum(j['conditional'] for j in packed if j['id'] in option['jobs'])
        return option

    jobs=data['jobs'];own=[j for j in jobs if not j['conditional']]
    scenarios=[(own,False)]
    if any(j['conditional'] for j in jobs):scenarios.append((jobs,False))
    if data.get('direct'):
        direct_ids={j['id'] for j in data['direct']}
        scenarios.append(([j for j in jobs if j['id'] not in direct_ids]+data['direct'],True))
    options=[]
    for pool,direct in scenarios:
        groups={}
        for j in pool:
            d=j.get('delivery') or {}
            if d.get('confidence')=='confirmed' and d.get('date'):groups.setdefault(d['date'],[]).append(j)
        # General same-day delivery order exploration, independent of town names.
        biases=[None]+[(j['id'],) for group in groups.values() if len({j['to'] for j in group})>1 for j in group]
        for capacity in (5,7,12):
            for bias in biases[:5]:
                option=solve(pool,capacity,bias)
                if option:option['direct']=direct;options.append(option)
            if time.monotonic()>=deadline:break
    # If all-date combination fails its driver screen, independently test each
    # dated pickup cluster with undated fill-ins rather than hide every order.
    if not options:
        deadline=started+budget
        dates=sorted({j.get('pickup',{}).get('date') for j in own if j.get('pickup') and j['pickup'].get('confidence')=='confirmed'}-{None})
        tested={tuple(j['id'] for j in own)}
        for date in dates:
            # Try nearby pickup days together, then widen. A conflicting later
            # booking must not hide a feasible outbound load and its detour.
            for days in (1,2,7):
                end=(datetime.fromisoformat(date)+timedelta(days=days)).date().isoformat()
                pool=[j for j in own if not j.get('pickup') or j['pickup'].get('confidence')!='confirmed' or date<=j['pickup'].get('date','')<end]
                key=tuple(j['id'] for j in pool)
                if key in tested:continue
                tested.add(key)
                delivery_groups={}
                for j in pool:
                    d=j.get('delivery') or {}
                    if d.get('confidence')=='confirmed' and d.get('date'):delivery_groups.setdefault(d['date'],[]).append(j)
                biases=[None]+[(j['id'],) for group in delivery_groups.values() if len({j['to'] for j in group})>1 for j in group]
                for bias in biases[:3]:
                    option=solve(pool,5,bias)
                    if option:option['direct']=False;options.append(option)
    options.sort(key=lambda o:(-o['own'],o['conditional'],-len(o['jobs']),o['capacity']>7,o['distance'],o['capacity']))
    unique=[];seen=set()
    for option in options:
        key=(tuple(option['jobs']),tuple((s['kind'],s.get('id'),s['town'],s['date']) for s in option['stops']))
        if key in seen:continue
        seen.add(key);unique.append(option)
        if len(unique)==4:break
    return {'options':unique,'engine':'PyVRP 0.14.1'}

if __name__=='__main__':
    data=json.load(sys.stdin)
    print(json.dumps(optimise(data),separators=(',',':')))
