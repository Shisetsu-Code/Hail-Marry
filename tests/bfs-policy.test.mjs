import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHint, discoverActions, demoMode, matchRoute, routeAllowed, stateFingerprint, screenPacket, isPurchaseConfirmationState } from '../src/navigation-policy.mjs';
import { GPTTextClassifier, ReviewStore, normalizeClassification } from '../src/gpt-review.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const dom=(id,label,props={})=>({ id, label, localId:'html/body/button#'+id, source:'dom', role:'button',
  stable:true, visible:true, enabled:true, geometryReliable:true, availability:'available',
  bounds:{x:100,y:100,width:150,height:55}, hitPoint:{x:140,y:127}, evidence:{kind:'dom-hit-test'},
  ...props });
const scene=(controls, lines=[])=>({controls,ocr:{lines},viewport:{width:1280,height:720},screenshot:'test.png'});

test('classifies only useful navigation and never spin/autoplay/final confirmation',()=>{
  assert.equal(classifyHint('Buy Bonus'),'bonus_entry');
  assert.equal(classifyHint('BuyFeature/ContentBuyFeature/ButtonCollider'),'bonus_entry');
  assert.equal(classifyHint('Free Spins 50 FUN'),'bonus_option');
  assert.equal(classifyHint('Ante Bet ON'),'ante_toggle');
  assert.equal(classifyHint('Bet +'),'bet_adjust');
  assert.equal(classifyHint('Settings'),'open_menu');
  assert.equal(classifyHint('CLICK ANYWHERE TO START'),'intro_continue');
  assert.equal(classifyHint('SPIN'),'spin');
  assert.equal(classifyHint('AUTOPLAY'),'autoplay');
  assert.equal(classifyHint('Confirm purchase'),'purchase_confirm');
});

test('BFS only traverses verified demo, never real money or confirmation',()=>{
  assert.equal(demoMode('https://demo.bgaming-network.com/play/test/FUN?server=demo'),true);
  assert.equal(demoMode('https://released.playngonetwork.com/casino/ContainerLauncher?demo=2&practice=1'),true);
  assert.equal(demoMode('https://demogamesfree.pragmaticplay.net/gs2c/openGame.do?jurisdiction=99'),true);
  assert.equal(demoMode('https://casino-pay.example/buy?demo=true'),false);
  assert.equal(demoMode('https://released.playngonetwork.com/casino/ContainerLauncher?demo=1'),false);
  assert.equal(demoMode('http://127.0.0.1:4178/bfs-game.html',{localFixture:true}),true);
  assert.equal(demoMode('http://127.0.0.1:4178/bfs-game.html'),false);
  const state=scene([dom('buy','Buy Bonus'),dom('spin','Spin'),dom('confirm','Confirm purchase'),dom('ante','Ante Bet OFF')]);
  const actions=discoverActions(state);
  const get=text=>actions.find(a=>a.text===text);
  assert.equal(routeAllowed(get('Buy Bonus'),{demo:false,initiateDemoPurchase:true}),false);
  assert.equal(routeAllowed(get('Buy Bonus'),{demo:true}),true);
  assert.equal(routeAllowed(get('Spin'),{demo:true}),false);
  assert.equal(routeAllowed(get('Confirm purchase'),{demo:true,initiateDemoPurchase:true}),false);
  assert.equal(routeAllowed(get('Ante Bet OFF'),{demo:true}),true);
  assert.equal(routeAllowed(get('Ante Bet OFF'),{demo:true,ancestry:[get('Ante Bet OFF')]}),false);
});

test('OCR requires two agreeing readings and a bounded geometry',()=>{
  const line=(text,readings)=>({text,readings,confidence:94,bounds:{x:110,y:116,width:90,height:28}});
  const state=scene([], [line('Free Spins 50 FUN',['psm6']),line('Buy Bonus',['psm6','psm11'])]);
  const actions=discoverActions(state);
  assert.equal(actions.some(a=>a.text==='Buy Bonus'),true);
  assert.equal(actions.some(a=>a.text==='Free Spins 50 FUN'),false);
});

test('route matching is strict with repeated labels; generated GPT labels cannot override spin',()=>{
  const state=scene([dom('one','Buy Bonus'),dom('two','Buy Bonus',{localId:'html/body/button#two',bounds:{x:350,y:100,width:150,height:55},hitPoint:{x:390,y:127}}),dom('spin','SPIN')]);
  const actions=discoverActions(state,{gptKinds:{spin:{kind:'bonus_entry',confidence:.999}}});
  const spin=actions.find(c=>c.text==='SPIN');
  assert.equal(spin.kind,'spin');
  assert.equal(routeAllowed(spin,{demo:true,initiateDemoPurchase:true}),false);
  const first=actions.find(c=>c.id==='one');
  assert.equal(matchRoute(state,first).id,'one');
  assert.equal(matchRoute(state,{...first,localPath:null}),null); // ambiguous duplicate text
});

test('state signature changes with modal controls and packet persists screen text',()=>{
  const a=scene([dom('buy','Buy Bonus')]);
  const b=scene([dom('buy','Buy Bonus'),dom('fs','Free Spins 50 FUN')]);
  assert.notEqual(stateFingerprint(a),stateFingerprint(b));
  const packet=screenPacket(b,discoverActions(b),[]);
  assert.equal(packet.screenshot,'test.png');
  assert.ok(packet.candidates.some(c=>c.kind==='bonus_option'));
});

test('BFS state fingerprint keeps bet levels while ignoring unrelated changing counters', () => {
  const line = text => ({ text, confidence: 90, bounds: { x: 20, y: 40, width: 150, height: 25 }, readings: ['a','b'] });
  const base = [dom('bet','Bet +')];
  assert.notEqual(stateFingerprint(scene(base,[line('Bet level 1')])), stateFingerprint(scene(base,[line('Bet level 2')])));
  assert.equal(stateFingerprint(scene(base,[line('Balance 1000')])), stateFingerprint(scene(base,[line('Balance 1002')])));
});

test('GPT accepts only observed IDs; queue remains honest when no key is configured',async()=>{
  const state=scene([dom('buy','Buy Bonus')], [{text:'Welcome to FUN Demo',confidence:91,bounds:{x:10,y:10,width:220,height:20},readings:['a','b']}]);
  const packet=screenPacket(state,discoverActions(state),[]);
  assert.throws(()=>normalizeClassification({screenKind:'gameplay',summary:'x',candidates:[{id:'invented',kind:'bonus_entry',confidence:.9}]},packet));
  const directory=await mkdtemp(path.join(os.tmpdir(),'hail-bfs-review-'));
  try {
    const store=new ReviewStore(directory,{classifier:new GPTTextClassifier({apiKey:''})});
    assert.equal(await store.record(packet),null);
    assert.equal(await store.record(packet),null);
    await store.save();
    const index=JSON.parse(await readFile(path.join(directory,'gpt-review-index.json'),'utf8'));
    assert.equal(index.total,1);assert.equal(index.entries[0].appearances,2);
    assert.equal(index.entries[0].status,'pending_gpt');
    const queue=(await readFile(path.join(directory,'gpt-review.jsonl'),'utf8')).trim().split('\n');
    assert.equal(queue.length,1);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('GPT structured output can label a new control but is not allowed to invent coordinates',async()=>{
  const state=scene([dom('mystery','Extra chance mode')]);
  const packet=screenPacket(state,discoverActions(state),[]);
  const fake=async(_url,request)=>{
    const b=JSON.parse(request.body);
    assert.equal(b.store,false);
    assert.equal(b.text.format.type,'json_schema');
    return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({screenKind:'bet_menu',summary:'toggle',candidates:[{id:packet.candidates[0].id,kind:'ante_toggle',confidence:.97}]})}]}]})};
  };
  const classifier=new GPTTextClassifier({apiKey:'fake-key',fetchFn:fake});
  const labels=await classifier.classify(packet);
  const actions=discoverActions(state,{gptKinds:labels.kinds});
  assert.equal(actions[0].kind,'ante_toggle');
  assert.equal(actions[0].gptDriven,true);
  assert.ok(matchRoute(state,{...actions[0],gptDriven:true}));
  assert.equal(actions[0].point.x,140);
});

test('UHT buy dialog YES/NO are protected confirmation controls, never new bonus routes', () => {
  const base = 'GameRoot/UI Root/XTRoot/Root/Game/BuyFeature/ContentBuyFeature';
  const engine = (label, suffix, x) => dom(label, label, {
    source: 'uht', localId: `1:UIButton:12:${base}/Buttons/${suffix}`,
    availability: 'unknown', hitPoint: null,
    bounds: {x,y:260,width:75,height:75},
  });
  const state = scene([
    engine('Button_Yes','Button_Yes',560),
    engine('Button_No','Button_No',260),
    engine('ButtonCollider','Button/ButtonCollider',780),
  ]);
  assert.equal(classifyHint(`${base}/Buttons/Button_Yes`), 'purchase_confirm');
  assert.equal(classifyHint(`${base}/Buttons/Button_No`), 'close_back');
  const actions = discoverActions(state, {gptKinds:{
    'Button_Yes':{kind:'bonus_entry',confidence:1},
    'Button_No':{kind:'bonus_option',confidence:1},
  }});
  assert.equal(actions.find(a => a.text === 'Button_Yes')?.kind, 'purchase_confirm');
  assert.equal(actions.find(a => a.text === 'Button_No')?.kind, 'close_back');
  assert.equal(actions.find(a => a.text === 'ButtonCollider')?.kind, 'bonus_entry');
  for (const action of actions.filter(a=>/Button_(Yes|No)/.test(a.text))) {
    assert.equal(routeAllowed(action,{demo:true,initiateDemoPurchase:true}),false);
    assert.equal(matchRoute(state,{...action,kind:'bonus_entry',gptDriven:false}),null);
  }
});

test('purchase modal stops traversal of underlying bet and bonus controls', () => {
  const base = scene([dom('buy','Buy Bonus'),dom('yes','Confirm purchase'),dom('bet','Bet +')]);
  const controls = discoverActions(base);
  assert.equal(isPurchaseConfirmationState(controls, []), false);
  assert.equal(isPurchaseConfirmationState(controls, [{kind:'bonus_entry'}]), true);
  assert.equal(isPurchaseConfirmationState(controls, [{kind:'bonus_option'}]), true);
  assert.equal(isPurchaseConfirmationState(controls.filter(c => c.text !== 'Confirm purchase'), [{kind:'bonus_entry'}]), false);
});
