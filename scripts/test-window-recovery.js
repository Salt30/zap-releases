const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { keepWindowAvailable } = require('../src/window-recovery');
function fixture() {
  const window = new EventEmitter(), contents = new EventEmitter();
  let destroyed=false,quitting=false,visible=true,loads=0,crashes=0,time=0,nextId=1,fail=false;
  Object.defineProperty(window,'webContents',{get(){assert.equal(destroyed,false,'Cleanup accessed a destroyed native window');return contents;}});
  const timers=new Map(),statuses=[];
  window.isDestroyed=()=>destroyed;window.hide=()=>{visible=false;};
  const recovery=keepWindowAvailable({window,isQuitting:()=>quitting,loadPage:async()=>{loads++;if(fail)throw Error('failed');},onCrash:()=>crashes++,onStatus:s=>statuses.push(s),now:()=>time,schedule:(fn,delay)=>{const id=nextId++;timers.set(id,{fn,delay});return id;},cancel:id=>timers.delete(id)});
  return {window,recovery,timers,statuses,loads:()=>loads,crashes:()=>crashes,visible:()=>visible,setTime:n=>{time=n;},fail:()=>{fail=true;},quit:()=>{quitting=true;recovery.stop();},destroy:()=>{destroyed=true;window.emit('closed');},crash:reason=>window.webContents.emit('render-process-gone',{}, {reason}),tick:async()=>{const [id,timer]=timers.entries().next().value;timers.delete(id);await timer.fn();}};
}
(async()=>{
 const f=fixture();let prevented=false;
 f.window.emit('close',{preventDefault:()=>{prevented=true;}});
 assert.equal(prevented,true);assert.equal(f.visible(),false);assert.equal(f.crashes(),0);
 f.window.emit('blur');assert.equal(f.visible(),false);assert.equal(f.timers.size,0);
 f.crash('crashed');assert.equal(f.crashes(),1);assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,1000);
 f.crash('crashed');assert.equal(f.timers.size,1,'Duplicate recovery scheduled');
 await f.tick();assert.equal(f.loads(),1);assert.equal(f.visible(),false,'Recovery stole focus or reopened a closed window');
 f.crash('oom');assert.equal([...f.timers.values()][0].delay,2000);await f.tick();
 f.crash('crashed');assert.equal([...f.timers.values()][0].delay,4000);await f.tick();
 f.crash('crashed');assert.equal(f.timers.size,0);assert.equal(f.statuses.at(-1),'paused');
 f.setTime(300001);f.crash('crashed');assert.equal(f.timers.size,1);f.quit();assert.equal(f.timers.size,0);
 prevented=false;f.window.emit('close',{preventDefault:()=>{prevented=true;}});assert.equal(prevented,false,'Quit was blocked');
 for(const reason of ['killed','clean-exit','integrity-failure']){const x=fixture();x.crash('crashed');x.crash(reason);assert.equal(x.timers.size,0);x.crash('crashed');assert.equal(x.timers.size,0,'Termination was overridden');}
 const d=fixture();d.crash('crashed');d.destroy();d.recovery.stop();assert.equal(d.timers.size,0);
 const bad=fixture();bad.fail();bad.crash('launch-failed');await bad.tick();await bad.tick();await bad.tick();assert.equal(bad.loads(),3);assert.equal(bad.timers.size,0);assert.equal(bad.statuses.at(-1),'paused');
 console.log('Window recovery passed: close-to-background, hidden recovery, bounded retries, duplicate suppression, teardown, explicit quit and termination respected.');
})().catch(error=>{console.error(error);process.exitCode=1});
