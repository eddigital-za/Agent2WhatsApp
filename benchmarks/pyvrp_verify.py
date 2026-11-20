"""Isolated synthetic shipment benchmark. No application imports or network calls."""
import json, math, re
from pathlib import Path
from pyvrp import Model
from pyvrp.stop import MaxRuntime

POINTS = {"Durban":(-29.858,31.029),"Johannesburg":(-26.202,28.044),
"Cape Town":(-33.926,18.423),"Malelane":(-25.494,31.511),
"Hoedspruit":(-24.35,30.95)}
def distance(a,b):
    p,q=POINTS[a],POINTS[b]
    x,y=map(math.radians,p); u,v=map(math.radians,q)
    h=math.sin((u-x)/2)**2+math.cos(x)*math.cos(u)*math.sin((v-y)/2)**2
    return round(12742000*math.asin(min(1,math.sqrt(h))))
def job(a,b,car=False,p=(0,20000),d=(0,20000),required=True):
    return dict(a=a,b=b,car=car,p=p,d=d,required=required)
def solve(name,jobs,bikes=7,expect=True):
    m=Model()
    loc={city:m.add_location(*xy,name=city) for city,xy in POINTS.items()}
    m.add_depot(loc["Durban"],tw_late=20000)
    cap=[bikes,1,max(7,bikes)]
    m.add_vehicle_type(1,capacity=cap,tw_late=20000)
    amounts=[]
    for i,j in enumerate(jobs):
        amount=[0,1,cap[2]-3] if j["car"] else [1,0,1]
        amounts.append(amount)
        m.add_shipment(loc[j["a"]],loc[j["b"]],
            pickup_tw_early=j["p"][0],pickup_tw_late=j["p"][1],
            delivery_tw_early=j["d"][0],delivery_tw_late=j["d"][1],
            amount=amount,required=j["required"],prize=10000000,name=f"anonymous-{i}")
    for a in loc:
        for b in loc:
            dist=distance(a,b)
            m.add_edge(loc[a],loc[b],distance=dist,duration=round(dist/1000))
    result=m.solve(MaxRuntime(3),seed=42,display=False)
    feasible=result.is_feasible()
    assert feasible == expect, (name,"unexpected feasibility",str(result.best))
    record=dict(name=name,feasible=feasible,capacity=cap,routes=[],unassigned=[])
    if feasible:
        served=set()
        for route in result.best.routes():
            # PyVRP's public route text uses L<i>/U<i> shipment activities.
            steps=re.findall(r"([LU])(\d+)",str(route))
            assert steps, str(route)
            load=[0,0,0]; picked=set(); delivered=set(); city="Durban"; time=route.start_time()
            travel=0; trace=[]
            for action,raw in steps:
                i=int(raw); j=jobs[i]; pickup=action=="L"
                target=j["a"] if pickup else j["b"]
                travel+=distance(city,target); time+=round(distance(city,target)/1000)
                early,late=j["p"] if pickup else j["d"]
                time=max(time,early)
                assert time<=late,(name,i,"time window",time,late)
                if pickup:
                    assert i not in picked
                    picked.add(i)
                else:
                    assert i in picked and i not in delivered
                    delivered.add(i)
                load=[v+(a if pickup else -a) for v,a in zip(load,amounts[i])]
                assert all(0<=v<=c for v,c in zip(load,cap)),(name,"capacity",load)
                trace.append(dict(action="pickup" if pickup else "delivery",order=i,city=target,load=load.copy(),minute=time))
                city=target
            assert picked==delivered
            assert not (served & delivered)
            served.update(delivered)
            travel+=distance(city,"Durban")
            assert travel==route.distance(),(travel,route.distance())
            record["routes"].append(dict(distance_m=travel,stops=trace))
        assert all(i in served for i,j in enumerate(jobs) if j["required"])
        record["unassigned"]=[i for i in range(len(jobs)) if i not in served]
    print(json.dumps(record))
    return record

reports=[]
reports.append(solve("northeast combined circuit",[
job("Durban","Johannesburg"),job("Johannesburg","Hoedspruit",car=True),
job("Johannesburg","Malelane"),job("Johannesburg","Durban")]))
reports.append(solve("Cape outbound and return",[
job("Durban","Cape Town"),job("Cape Town","Durban")]))
reports.append(solve("one car and three bikes",[
job("Durban","Johannesburg",car=True)]+[job("Durban","Johannesburg") for _ in range(3)]))
# Fixed departure windows prevent capacity violations being hidden by repeat shuttles.
reports.append(solve("one car and four bikes cannot depart together",[
job("Durban","Johannesburg",car=True,p=(0,0))]+
[job("Durban","Johannesburg",p=(0,0)) for _ in range(4)],expect=False))
reports.append(solve("seven bike own trailer",[
job("Durban","Johannesburg",p=(0,0)) for _ in range(7)]))
reports.append(solve("eight bikes exceed own trailer",[
job("Durban","Johannesburg",p=(0,0)) for _ in range(8)],expect=False))
reports.append(solve("twelve bike hired trailer",[
job("Durban","Johannesburg",p=(0,0)) for _ in range(12)],bikes=12))
reports.append(solve("incompatible dates rejected",[
job("Johannesburg","Cape Town",p=(1000,1000),d=(0,100))],expect=False))
r=solve("optional impossible order accounted for",[
job("Durban","Johannesburg"),
job("Johannesburg","Cape Town",p=(1000,1000),d=(0,100),required=False)])
assert r["unassigned"]==[1]
reports.append(r)
Path("benchmark-results.json").write_text(json.dumps({
"scope":"synthetic only; centroid distances and synthetic minutes, not road routing",
"production_changed":False,"tests_passed":len(reports),"results":reports},indent=2))
print(f"PASS: {len(reports)} independent scenario checks")
