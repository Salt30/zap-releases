const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { keepWindowAvailable } = require('../src/window-recovery');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'zap-background-test-')));
app.setName('Zap Background Verification');
let quitting=false,recovery;
let stage='startup';
const deadline=setTimeout(()=>{console.error(`Background fixture stalled at ${stage}`);app.exit(1);},20000);
app.on('before-quit',()=>{quitting=true;recovery?.stop();});
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8');
 const definition=source.slice(source.indexOf('function windowOptions('),source.indexOf('function createMainWindow('));
 const context=vm.createContext({path,app,__dirname:path.join(__dirname,'../build-app')});vm.runInContext(definition,context);
 const window=new BrowserWindow({...context.windowOptions({backgroundWork:true}),show:false,width:500,height:300});
 const page='data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27"><title>Zap background verification</title><p>Isolated background test</p>';
 let reloads=0,cancelled=0,reloadDone=false;
 const existingCrashListeners=window.webContents.listeners('render-process-gone');
 recovery=keepWindowAvailable({window,isQuitting:()=>quitting,loadPage:async()=>{reloads++;await window.loadURL(page);reloadDone=true;},onCrash:()=>cancelled++});
 const crashListener=window.webContents.listeners('render-process-gone').find(listener=>!existingCrashListeners.includes(listener));
 await window.loadURL(page);
 window.showInactive();
 await new Promise(resolve=>setTimeout(resolve,100));
 stage='hidden job';
 assert.equal(window.webContents.getBackgroundThrottling(),false);
 const job=window.webContents.executeJavaScript('new Promise(resolve => setTimeout(() => resolve("finished while hidden"), 250))');
 window.close();assert.equal(window.isDestroyed(),false);assert.equal(window.isVisible(),false);
 assert.equal(await job,'finished while hidden');
 stage='recovery';
 // Simulate a crash notification without intentionally crashing an OS process.
 // Invoke only our listener so this test does not simulate a crash to Electron's
 // own native lifecycle listeners while their renderer is still healthy.
 crashListener({}, {reason:'crashed'});
 for(let i=0;i<240&&!reloadDone;i++)await new Promise(r=>setTimeout(r,25));
 assert.equal(reloadDone,true);
 assert.equal(reloads,1);assert.equal(cancelled,1);assert.equal(window.isVisible(),false);
 stage='quit';
 app.once('will-quit',()=>{
  assert.equal(window.isDestroyed(),true);
  stage='native process exit after window teardown';
 });
 app.once('quit',()=>{
  clearTimeout(deadline);
  console.log('Background integration passed: actual Electron window settings, hidden job completion, close-to-background, simulated crash reload, no focus stealing, and quit teardown.');
 });
 // Dispatch Quit on a fresh event-loop turn, as the tray/menu action does.
 setImmediate(()=>app.quit());
}).catch(error=>{console.error(error);app.exit(1);});
