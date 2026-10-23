import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import { mapConcurrent } from './timing.mjs';
import { BFSNavigator } from './bfs-navigator.mjs';
import { ReviewStore, GPTTextClassifier } from './gpt-review.mjs';

function readArgs(argv) {
  const flags = {};
  for (let i=0;i<argv.length;i++) {
    if (!argv[i].startsWith('--') || !argv[i+1] || argv[i+1].startsWith('--')) throw new Error('Use --name value for all arguments');
    flags[argv[i].slice(2)]=argv[++i];
  }
  return flags;
}
const flags=readArgs(process.argv.slice(2));
const config=flags.url ? { demos:[{id:'custom-demo',url:flags.url}] } : JSON.parse(await readFile(flags.config || 'config/demos.json','utf8'));
if (!Array.isArray(config.demos) || config.demos.length === 0) throw new Error('No demos');
const gameConcurrency=Number(flags['games-concurrency'] || 1);
const branchConcurrency=Number(flags['branch-concurrency'] || 2);
const initialWaitMs=Number(flags['initial-wait-ms'] ?? 60000);
const localFixture=flags['local-fixture'] === 'true';
if ((!localFixture && initialWaitMs < 60000) || initialWaitMs < 0) throw new Error('Live demos require 60 seconds without initial input');
const out=path.resolve(flags.out || 'artifacts/bfs');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
  args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const classifier=flags.gpt === 'true' ? new GPTTextClassifier() : new GPTTextClassifier({apiKey:''});
if (flags.gpt === 'true' && !classifier.enabled) throw new Error('GPT classification requested; set OPENAI_API_KEY in GitHub Actions secrets');
const results=[];
try {
  const completed=await mapConcurrent(config.demos,gameConcurrency,async target=>{
    const id=String(target.id).replace(/[^\w-]/g,'-');
    const destination=path.join(out,id);
    const review=new ReviewStore(path.join(destination,'review'),{classifier});
    const navigator=new BFSNavigator({browser,target:{...target,deviceConfig:target.device ? devices[target.device] : undefined},outputDir:destination,reviewStore:review,
      initialWaitMs,maxDepth:Number(flags['max-depth'] ?? 3), maxNodes:Number(flags['max-nodes'] ?? 20),
      maxPerNode:Number(flags['max-per-node'] ?? 8), concurrency:branchConcurrency,
      initiateDemoPurchase:flags['initiate-demo-purchase'] === 'true',localFixture,
      onEvent: event=>process.stdout.write(JSON.stringify({game:id,...event})+'\n'),
    });
    const graph=await navigator.run();
    return { id, demo:graph.demo, metrics:graph.metrics, errors:graph.errors,
      graph:path.join(id,'bfs-graph.json'), review:path.join(id,'review','gpt-review-index.json') };
  });
  for(const r of completed) results.push(r.status === 'fulfilled' ? r.value : {status:'failed',error:r.reason});
} finally { await browser.close(); }
const summary={ finishedAt:new Date().toISOString(), gameConcurrency,branchConcurrency,gptEnabled:classifier.enabled,results };
await writeFile(path.join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
if (results.some(r=>r.status==='failed'||r.errors?.length||(!r.metrics?.visited))) process.exitCode=2;
