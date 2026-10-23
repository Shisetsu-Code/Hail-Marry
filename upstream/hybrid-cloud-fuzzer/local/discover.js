// Operator-approved public DEMO catalogue discovery.
// No guesses about unknown providers, login-gated sites, or real-money casinos.
const slug=/^[a-z0-9][a-z0-9-]{0,98}$/i;
const forbidden=/(^localhost$|\.localhost$|\.local$|\.internal$|\.test$|\.invalid$|\.example$)/i;
function publicUrl(raw){
 let url;
 try{url=new URL(raw);}catch{throw Error('invalid catalogue URL');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)throw Error('public HTTPS URL required');
 const host=url.hostname.toLowerCase();
 if(forbidden.test(host)||!host.includes('.')||/^\d+\.\d+\.\d+\.\d+$/.test(host)||host.includes(':'))throw Error('non-public catalogue host rejected');
 return url;
}
// Deterministic ID for a time-bucketed provider scan, shared by the producer
// and the consumer. The original source.id remains unchanged in job payloads.
export function discoveryTicketSubject(sourceId,bucket){
 if(!slug.test(sourceId||'')||sourceId.length>75)throw Error('discovery source id must be <=75 characters');
 if(!Number.isSafeInteger(bucket)||bucket<0)throw Error('invalid discovery bucket');
 return sourceId+'-'+bucket;
}
export function validateDiscoveryTicket(job){
 const source=job?.payload?.source;
 const config=validateDiscoverySource(source);
 const subject=String(job?.subject||'');
 const prefix=config.id+'-';
 const suffix=subject.startsWith(prefix)?subject.slice(prefix.length):'';
 if(config.provider!==job.provider||!/^\d{1,12}$/.test(suffix)||
  discoveryTicketSubject(config.id,Number(suffix))!==subject)
  throw Error('discovery identity mismatch');
 return source;
}

export function validateDiscoverySource(source){
 if(!source||typeof source!=='object'||Array.isArray(source))throw Error('provider source required');
 if(!slug.test(source.provider||''))throw Error('invalid discovery provider');
 if(!slug.test(source.id||'')||source.id.length>75)throw Error('discovery source id must be <=75 characters');
 if(source.enabled!==true||source.approved!==true)throw Error('discovery source not explicitly approved');
 const prefix=publicUrl(source.gameUrlPrefix);
 if(!prefix.pathname.endsWith('/'))throw Error('gameUrlPrefix must be a directory path');
 if(!Array.isArray(source.indexUrls)||source.indexUrls.length<1||source.indexUrls.length>12)throw Error('1..12 indexUrls required');
 const indexes=source.indexUrls.map(publicUrl);
 if(indexes.some(x=>x.origin!==prefix.origin))throw Error('catalogue links must share explicit game host');
 const pattern=source.gamePathPattern||'^[a-z0-9/-]+/$';
 if(typeof pattern!=='string'||pattern.length>180||!pattern.startsWith('^')||!pattern.endsWith('$'))throw Error('anchored game URL path pattern required');
 // Path must be restricted to the approved directory even if a pattern is wider.
 const re=new RegExp(pattern);
 return {id:source.id,provider:source.provider,indexUrls:indexes.map(x=>x.href),
  gameUrlPrefix:prefix.href,gamePathPattern:re,verifiedDemo:source.verifiedDemo===true,
  maxGames:Math.min(150,Math.max(1,Number(source.maxGames)||100))};
}
export function selectPublicDemoLinks(links,source){
 const config=validateDiscoverySource(source);
 const prefix=new URL(config.gameUrlPrefix);
 const games=new Map();
 for(const raw of links||[]){
  if(typeof raw!=='string')continue;
  let url;try{url=new URL(raw,prefix);}catch{continue;}
  if(url.origin!==prefix.origin||url.username||url.password||url.search||url.hash||
     !url.pathname.startsWith(prefix.pathname)||!config.gamePathPattern.test(url.pathname))continue;
  const slugId=url.pathname.split('/').filter(Boolean).at(-1);
  if(!slug.test(slugId||''))continue;
  games.set(slugId,{provider:config.provider,gameId:slugId,url:url.href});
  if(games.size>=config.maxGames)break;
 }
 return [...games.values()];
}
export async function discoverPublicDemos(browser,source,{timeoutMs=30000}={}){
 const config=validateDiscoverySource(source);
 const ctx=await browser.newContext({serviceWorkers:'block'});
 const all=[];
 try{
  const page=await ctx.newPage();
  for(const url of config.indexUrls){
   // Redirected catalogue pages are not trusted. Game links are never clicked.
   const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:timeoutMs});
   if(!response||response.status()>=400)throw Error('public catalogue HTTP error');
   if(new URL(page.url()).origin!==new URL(url).origin)throw Error('catalogue redirected across origins');
   const found=await page.locator('a[href]').evaluateAll(nodes=>nodes.map(a=>a.href).slice(0,1500));
   all.push(...found);
  }
 }finally{await ctx.close();}
 return {provider:config.provider,verifiedDemo:config.verifiedDemo,
  games:selectPublicDemoLinks(all,source),pagesScanned:config.indexUrls.length};
}
