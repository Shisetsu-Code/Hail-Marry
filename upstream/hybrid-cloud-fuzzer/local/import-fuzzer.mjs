#!/usr/bin/env node
// Convert previous Fuzzer-Manual catalog-exports to the hybrid outbox.
// No game is reopened. Supports --watch for new captures.
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {cli,readJSON,writeAtomic,safeId} from './utils.js';
import {frameSummary} from './extract.js';
const args=cli(process.argv.slice(2));
const source=path.resolve(args.source||'.');if(process.argv[1]?.endsWith('import-fuzzer.mjs')&&!args.source)throw Error('--source=.../Fuzzer-Manual/data/catalog-exports/<run> required');
const out=path.resolve(args.out||'outbox');
const interval=Number(args['interval-ms']||12000);if(!Number.isInteger(interval)||interval<2000)throw Error('interval-ms >=2000 required');
export function convert(row,meta,runId){
  const provider=safeId(row.provider||meta.provider||'pragmatic','provider'),gameId=safeId(row.slug||meta.slug,'slug');
  const shotId=safeId(`task-${row.taskId}`,'shotId');
  const candidates=(meta.controls||[]).filter(c=>c?.hit&&c.hit.w>0&&c.hit.h>0&&c.hit.x>=0&&c.hit.y>=0&&c.hit.x+c.hit.w<=1.00001&&c.hit.y+c.hit.h<=1.00001).slice(0,220).map(c=>{
    const label=c.texts?.filter(t=>typeof t==='string'&&t.trim()).slice(0,2).join(' / ').slice(0,180)||c.name||c.path?.split('/').at(-1)||'Button';
    const matched=/Buy|Purchase|Ante|Feature|Bonus|Pick|Option|FreeSpin|Collect|IntroScreen/i.test(label+' '+c.path);
    return {label,source:'runtime',role:'button',path:c.path||'',confidence:matched?0.91:0.58,rect:{x:c.hit.x,y:c.hit.y,w:c.hit.w,h:c.hit.h}};
  });
  const state=['BASE','INTRO','BUY_MENU','CONFIRM','BONUS','UNKNOWN'].includes(row.state||meta.state)?(row.state||meta.state):'UNKNOWN';
  const analyzed=frameSummary({adapter:'fuzzer-manual-import',adapterVersion:'1',state,opaqueCanvas:true,candidates},{forceImage:state==='INTRO'});
  // Saved screenshot is kept as a visual fallback even if control IDs are available.
  return {runId,provider,gameId,shotId,state,mode:analyzed.mode,adapter:analyzed.adapter,adapterVersion:analyzed.adapterVersion,
    candidates:analyzed.candidates,width:meta.viewport?.width||meta.width||1024,height:meta.viewport?.height||meta.height||576,
    metadata:{source:'Fuzzer-Manual',taskId:row.taskId,capturedAt:row.capturedAt||meta.capturedAt||null,
      originalImage:row.image,originalMetadata:row.metadata,controlsCount:candidates.length,opaqueCanvas:true}};
}
export async function runImport({sourceDir=source,outDir=out,log=console.log}={}){
  const manifest=await readJSON(path.join(sourceDir,'manifest.json'));
  if(!manifest?.runId||!manifest.entries)throw Error('Invalid manifest.json');
  safeId(manifest.runId,'runId');await fs.mkdir(outDir,{recursive:true});
  let added=0,skipped=0,missing=0;
  for(const row of Object.values(manifest.entries)){
    if(!['ready','review'].includes(row.status)||!row.image||!row.metadata){skipped++;continue;}
    const image=path.resolve(sourceDir,row.image),metadata=path.resolve(sourceDir,row.metadata);
    if(!image.startsWith(sourceDir+path.sep)||!metadata.startsWith(sourceDir+path.sep))throw Error('Unsafe manifest path');
    let raw,meta;try{[raw,meta]=await Promise.all([fs.readFile(image),readJSON(metadata)]);}catch(e){if(e.code==='ENOENT'){missing++;continue;}throw e;}
    if(!meta){missing++;continue;}
    if(raw[0]!==255||raw[1]!==216||raw.at(-2)!==255||raw.at(-1)!==217){missing++;continue;}
    const item=convert(row,meta,manifest.runId);
    const base=`${item.runId}__${item.provider}__${item.gameId}__${item.shotId}`;
    const file=path.join(outDir,base+'.json'),jpg=path.join(outDir,base+'.jpg');
    if(await fs.stat(file).catch(()=>null)){skipped++;continue;}
    await fs.writeFile(jpg,raw);await writeAtomic(file,item);added++;
  }
  log(`IMPORT added=${added} skipped=${skipped} missing=${missing}`);return {added,skipped,missing};
}
if(process.argv[1]?.endsWith('import-fuzzer.mjs')){
  do{await runImport();if(args.watch)await sleep(interval);}while(args.watch);
}
