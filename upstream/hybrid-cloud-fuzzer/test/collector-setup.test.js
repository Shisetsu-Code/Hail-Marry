import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here=fileURLToPath(new URL('../scripts/',import.meta.url));
async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hybrid-collector-setup-'));
  const scripts=path.join(root,'scripts');await fs.mkdir(scripts);
  for(const file of ['collector-control.ps1','collector-setup.ps1']){
    await fs.copyFile(path.join(here,file),path.join(scripts,file));
  }
  return root;
}
function powershell(file,args=[]){return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,...args],{encoding:'utf8',windowsHide:true});}

test('Stop creates missing .local-state and is idempotent on a fresh Windows checkout',{skip:process.platform!=='win32'},async()=>{
  const root=await fixture();try{
    const command=path.join(root,'scripts','collector-control.ps1');
    assert.equal((await fs.stat(path.join(root,'.local-state')).catch(()=>null)),null);
    powershell(command,['-Action','Stop']);powershell(command,['-Action','Stop']);
    const record=JSON.parse(await fs.readFile(path.join(root,'.local-state','collection-processes.json'),'utf8'));
    assert.deepEqual(record,{});
    const status=JSON.parse(powershell(command,['-Action','Status']));
    assert.equal(status.captureRunning,false);assert.equal(status.syncRunning,false);assert.equal(status.branchesRunning,false);
    assert.equal(status.configPresent,false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('setup writes remote-only run manifest without BOM, keeps existing config and never fabricates tokens',{skip:process.platform!=='win32'},async()=>{
  const root=await fixture();try{
    const setup=path.join(root,'scripts','collector-setup.ps1');
    const cmd=['-RunId','hybrid-pragmatic-20261019','-WorkerUrl','https://example.workers.dev'];
    powershell(setup,cmd);
    const dir=path.join(root,'.local-state');
    const conf=JSON.parse(await fs.readFile(path.join(dir,'collector-control.json'),'utf8'));
    assert.equal(conf.workerUrl,'https://example.workers.dev');
    assert.ok(path.isAbsolute(conf.manifest));assert.ok(path.isAbsolute(conf.outbox));
    assert.equal(conf.speed,1);assert.equal(conf.rate,3);
    const buf=await fs.readFile(conf.manifest);assert.notEqual(buf[0],0xef,'no UTF-8 BOM for Node JSON.parse');
    const manifest=JSON.parse(buf.toString('utf8'));
    assert.equal(manifest.runId,'hybrid-pragmatic-20261019');assert.deepEqual(manifest.games,[]);
    assert.equal(await fs.stat(path.join(root,'.wrangler','deployment-secrets.xml')).catch(()=>null),null);
    powershell(setup,['-RunId','other-run','-WorkerUrl','https://wrong.workers.dev']);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir,'collector-control.json'),'utf8')).workerUrl,'https://example.workers.dev');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Start without config reports the setup command instead of a missing-file stack trace',{skip:process.platform!=='win32'},async()=>{
 const root=await fixture();try{
  const script=path.join(root,'scripts','collector-control.ps1');
  assert.throws(()=>powershell(script,['-Action','Start']),/collector-setup\.ps1/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('dynamic-workforce Windows bootstrap persists the opt-in mode without fabricating secrets',
 {skip:process.platform!=='win32'},async()=>{
 const root=await fixture();
 try{
  const setup=path.join(root,'scripts','collector-setup.ps1');
  const control=path.join(root,'scripts','collector-control.ps1');
  powershell(setup,['-RunId','test-dynamic-run','-WorkerUrl','https://example.workers.dev','-DynamicWorkers','-MaxWorkers','5','-BrowserWorkers','3']);
  const settings=JSON.parse(await fs.readFile(path.join(root,'.local-state','collector-control.json'),'utf8'));
  assert.equal(settings.dynamicWorkers,true);
  assert.equal(settings.maxWorkers,5);
  assert.equal(settings.browserWorkers,3);
  assert.equal(settings.adultConfirmed,false,'adult gating is never bypassed by dynamic mode');
  const status=JSON.parse(powershell(control,['-Action','Status']));
  assert.equal(status.dynamicWorkersConfigured,true);
  assert.equal(status.workforceRunning,false);
  assert.equal(status.branchesRunning,false);
  assert.equal(await fs.stat(path.join(root,'.wrangler','deployment-secrets.xml')).catch(()=>null),null);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
