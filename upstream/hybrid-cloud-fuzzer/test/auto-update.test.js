import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {updateDrainRequested,updateDrainPath} from '../local/update-drain.js';

const repoRoot=fileURLToPath(new URL('../',import.meta.url));
test('cooperative drain is absent by default and becomes visible without touching outbox',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hybrid-auto-update-'));
 try{
  assert.equal(await updateDrainRequested(root),false);
  const marker=updateDrainPath(root);
  await fs.mkdir(path.dirname(marker),{recursive:true});
  await fs.writeFile(marker,'updated-target-sha');
  assert.equal(await updateDrainRequested(root),true);
  await fs.unlink(marker);
  assert.equal(await updateDrainRequested(root),false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('Cloudflare deployment is restricted to main and migrations precede deployment',async()=>{
 const file=await fs.readFile(path.join(repoRoot,'.github/workflows/deploy-cloudflare.yml'),'utf8');
 assert.match(file,/branches:\s*\[main\]/);
 assert.match(file,/vars\.ENABLE_CF_GITHUB_DEPLOY/);
 assert.match(file,/secrets\.CLOUDFLARE_API_TOKEN/);
 assert.match(file,/secrets\.CLOUDFLARE_ACCOUNT_ID/);
 assert.ok(file.indexOf('wrangler d1 migrations apply')>file.indexOf('npm test'));
 assert.ok(file.indexOf('wrangler deploy')>file.indexOf('wrangler d1 migrations apply'));
 assert.match(file,/schemaVersion\s*>=\s*4/);
 assert.match(file,/workforceReady\s*==\s*true/);
 assert.match(file,/pacingReady\s*==\s*true/);
});
test('managed controller and updater scripts parse as Windows PowerShell',{
 skip:process.platform!=='win32'},()=>{
 const names=['collector-control.ps1','collector-worker.ps1','collector-update.ps1','collector-setup.ps1'];
 for(const name of names){
  const file=path.join(repoRoot,'scripts',name).replaceAll("'","''");
  const command="$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('"+file+"',[ref]$null,[ref]$errors); if($errors.Count){throw ($errors | Out-String)}";
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{stdio:'pipe',windowsHide:true});
 }
});
test('updater refuses unknown origin and leaves local git history intact',{
 skip:process.platform!=='win32'},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hybrid-auto-repo-'));
 try{
  const scripts=path.join(root,'scripts');
  await fs.mkdir(scripts);
  await fs.copyFile(path.join(repoRoot,'scripts','collector-update.ps1'),path.join(scripts,'collector-update.ps1'));
  execFileSync('git',['-C',root,'init','-b','main'],{stdio:'pipe',windowsHide:true});
  execFileSync('git',['-C',root,'remote','add','origin','https://github.com/SomeoneElse/not-approved.git'],{stdio:'pipe',windowsHide:true});
  const target=path.join(scripts,'collector-update.ps1');
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',target,'-Once','-CheckOnly'],{stdio:'pipe',windowsHide:true});
  const status=JSON.parse(await fs.readFile(path.join(root,'.local-state','auto-update-status.json'),'utf8'));
  assert.equal(status.state,'deferred');
  assert.match(status.message,/approved/i);
  assert.equal(await fs.stat(path.join(root,'.local-state','update-drain.flag')).catch(()=>null),null);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
