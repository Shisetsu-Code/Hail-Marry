import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
const controller=fileURLToPath(new URL('../scripts/collector-control.ps1',import.meta.url));
test('Windows collector controller never adopts an unrelated process just because its PID is recorded',{skip:process.platform!=='win32'},async()=>{
 assert.ok(existsSync(controller),'Collector controller must exist');
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
 try{
  const quoted=controller.replaceAll("'","''");
  const script=`. '${quoted}'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}'; $record=@{capturePid=${child.pid};captureStartedAt=$p.CreationDate.ToString('o')}; if(Get-ManagedWorker -Role Capture -Record $record){throw 'Unrelated process was adopted'}; if(-not (Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue)){throw 'Unrelated process was killed'}`;
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{stdio:'pipe',windowsHide:true});
  assert.ok(child.pid);
 }finally{child.kill();}
});
