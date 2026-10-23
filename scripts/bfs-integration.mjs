import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startFixtureServer } from './fixture-server.mjs';
import { BFSNavigator } from '../src/bfs-navigator.mjs';
import { ReviewStore, GPTTextClassifier } from '../src/gpt-review.mjs';
const fixture=await startFixtureServer();
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH || undefined});
const outputDir='artifacts/bfs-fixture';
await mkdir(outputDir,{recursive:true});
let result;
try {
  result=await new BFSNavigator({browser,target:{id:'bfs-fixture',url:fixture.url+'/bfs-game.html'},
    outputDir,localFixture:true,initialWaitMs:0,maxDepth:2,maxNodes:20,maxPerNode:8,concurrency:2,
    initiateDemoPurchase:true,reviewStore:new ReviewStore(outputDir+'/review',{classifier:new GPTTextClassifier({apiKey:''})}),
    onEvent:event=>process.stdout.write(JSON.stringify(event)+'\n'),
  }).run();
  const routes=result.nodes.map(n=>n.pathKey);
  assert.equal(result.demo,true);
  assert.ok(result.metrics.discoveredBonusEntries>=1,'should discover Buy Bonus entry');
  assert.ok(result.metrics.discoveredBetControls>=2,'should discover Bet + and Bet -');
  assert.ok(result.metrics.discoveredAnteControls>=1,'should discover Ante Bet toggle');
  assert.ok(result.metrics.discoveredBonusOptions>=2,'should discover at least 2 bonus choices');
  assert.ok(result.metrics.demoPurchaseOptionsVisited>=2,'should independently open both bonus options');
  assert.ok(result.metrics.purchaseConfirmationsBlocked>=1,'final purchase confirmation must be observed but NEVER clicked');
  assert.ok(!result.nodes.some(n=>['spin','autoplay','purchase_confirm'].includes(n.via?.kind)), 'no spin, autoplay or final purchase');
  const review=JSON.parse(await readFile(outputDir+'/review/gpt-review-index.json','utf8'));
  assert.ok(review.total>=3,'new screen texts queued for GPT');
  assert.ok(review.entries.every(e=>e.status==='pending_gpt'),'without API key no results may claim GPT inference');
  assert.equal(result.metrics.failed,0,'valid demo routes should replay without stale state errors');
  const compact={status:'passed',visited:result.metrics.visited,unique:result.metrics.uniqueStates,
    bonusEntries:result.metrics.discoveredBonusEntries,bonusOptions:result.metrics.discoveredBonusOptions,
    bonusInitiations:result.metrics.demoPurchaseOptionsVisited,
    confirmationBlocks:result.metrics.purchaseConfirmationsBlocked,
    betControls:result.metrics.discoveredBetControls,anteControls:result.metrics.discoveredAnteControls,
    reviewPackets:review.total,routeCount:routes.length};
  await writeFile(outputDir+'/bfs-result.json',JSON.stringify(compact,null,2)+'\n');
  console.log(JSON.stringify(compact,null,2));
} catch(error) {
  await writeFile(outputDir+'/bfs-result.json',JSON.stringify({status:'failed',error:String(error.stack || error),metrics:result?.metrics},null,2)+'\n');
  throw error;
} finally { await browser.close(); await fixture.close(); }
