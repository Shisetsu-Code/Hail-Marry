// Deterministic, bounded resource allocation for dynamic local workers.
// Browser workers are heavier than structured classification workers.
export const WORK_ROLES=Object.freeze(['discovery','catalog','classification','branches']);
const DEFAULT_MAX=Object.freeze({discovery:1,catalog:2,classification:2,branches:1});
const BROWSER=new Set(['discovery','catalog','branches']);
const safeInt=v=>Number.isSafeInteger(v)&&v>0?v:0;
function demandFor(snapshot,{structuredAuto=true,discover=true,branches=true}={}){
 const jobs=snapshot?.jobs||{},captures=snapshot?.captures||{};
 return {
  discovery:discover?safeInt(jobs.discovery?.pending)+safeInt(jobs.discovery?.leased):0,
  catalog:safeInt(jobs.catalog?.pending)+safeInt(jobs.catalog?.leased),
  classification:structuredAuto?safeInt(captures.structured):0,
  branches:branches&&safeInt(snapshot?.actionableClassifications)>0?1:0
 };
}
export function planWorkforce(snapshot,{maxWorkers=5,browserWorkers=3,perRoleMax={},
 structuredAuto=true,discoveryEnabled=true,branchesEnabled=true}={}){
 if(!Number.isSafeInteger(maxWorkers)||maxWorkers<1||maxWorkers>24)throw Error('maxWorkers must be 1..24');
 if(!Number.isSafeInteger(browserWorkers)||browserWorkers<1||browserWorkers>8)throw Error('browserWorkers must be 1..8');
 const limits={};
 for(const role of WORK_ROLES){
  const cap=perRoleMax[role]??DEFAULT_MAX[role];
  if(!Number.isSafeInteger(cap)||cap<0||cap>24)throw Error('invalid role worker cap: '+role);
  limits[role]=cap;
 }
 const demand=demandFor(snapshot,{structuredAuto,discover:discoveryEnabled,branches:branchesEnabled});
 const allocated={discovery:0,catalog:0,classification:0,branches:0};
 let total=0,browsers=0;
 const can=role=>total<maxWorkers&&allocated[role]<limits[role]&&allocated[role]<demand[role]&&
  (!BROWSER.has(role)||browsers<browserWorkers);
 const add=role=>{allocated[role]++;total++;if(BROWSER.has(role))browsers++;};
 // Prevent starvation of any active lane before increasing another's capacity.
 // Branches have priority because they release the next classification round.
 for(const role of ['branches','classification','catalog','discovery'])if(can(role))add(role);
 const weights={classification:1.4,catalog:1.2,branches:1,discovery:1};
 while(total<maxWorkers){
  let best=null,score=-Infinity;
  for(const role of WORK_ROLES){
   if(!can(role))continue;
   const value=weights[role]*Math.log2(demand[role]+1)/(allocated[role]+1);
   if(value>score){best=role;score=value;}
  }
  if(!best)break;
  add(best);
 }
 return {roles:allocated,demand,total,browserWorkers:browsers,
  visualReviewBacklog:safeInt(snapshot?.captures?.hybrid)+safeInt(snapshot?.captures?.visual),
  blockedCaptures:safeInt(snapshot?.captures?.needsReview),
  unfilled:maxWorkers-total};
}
