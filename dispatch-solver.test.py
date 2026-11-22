"""Synthetic inputs only; tests have no network or production access."""
import importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('solver',Path(__file__).with_name('dispatch-solver.py'))
solver=importlib.util.module_from_spec(spec);spec.loader.exec_module(solver)
eta=lambda day:{'date':day,'precision':'day','confidence':'confirmed'}
base={'today':'2027-05-01','instant':'2027-05-01T04:00:00Z',
 'towns':['Durban','Test North','Test Coast'],
 'distances':[[0,400000,600000],[400000,0,300000],[600000,300000,0]],
 'durations':[[0,20000,27000],[20000,0,16000],[27000,16000,0]],'direct':[]}
def job(i,a,b,**extra):
 return {'id':str(i),'from':a,'to':b,'bikes':1,'cars':0,'pickup':None,'delivery':None,'conditional':False,**extra}
data={**base,'jobs':[job(1,0,1,pickup=eta('2027-05-03')),job(2,1,2),job(3,2,0)]}
before=repr(data)
result=solver.optimise(data,budget=5)
assert repr(data)==before
assert result['options']
for option in result['options']:
 assert option['stops'][0]['kind']=='Start' and option['stops'][-1]['kind']=='Return'
 assert option['stops'][-1]['town']=='Durban'
 picked=set();delivered=set()
 for stop in option['stops']:
  if stop['kind']=='Pickup':
   assert stop['id'] not in picked;picked.add(stop['id'])
   if stop['id']=='1':assert stop['date']=='2027-05-03'
  elif stop['kind']=='Drop-off':
   assert stop['id'] in picked and stop['id'] not in delivered;delivered.add(stop['id'])
  assert stop['cars']<=1 and stop['bikes']<=(3 if stop['cars'] else option['capacity'])
 assert picked==delivered==set(option['jobs'])
assert any(len(o['jobs'])==3 for o in result['options'])
bad={**base,'jobs':[job(4,0,1,pickup=eta('2027-05-05'),delivery=eta('2027-05-03'))]}
assert solver.optimise(bad,budget=2)['options']==[]
print('PASS: real PyVRP worker, automatic onward/return pairing, confirmed dates, precedence, dynamic capacity, future departure, one-vehicle return and impossible dates. Synthetic data only.')
