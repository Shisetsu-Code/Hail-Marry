import test from 'node:test';
import assert from 'node:assert/strict';
import {bestFrame,framePriority,screenshotBox} from '../local/select-frame.js';

const info=(label,opaque=false,adapter='generic-dom')=>({adapter,state:'UNKNOWN',candidates:label?[{label,path:label}]:[],metadata:{opaqueCanvas:opaque}});
test('prefer actual game canvas iframe to parent page navigation buttons',async()=>{
 const parent={isDetached:()=>false},child={isDetached:()=>false};
 const page={frames:()=>[parent,child],mainFrame:()=>parent};
 const selected=await bestFrame(page,'unknown',{extract:async f=>f===parent?{
    ...info('BUY FEATURE'),candidates:Array.from({length:12},()=>({label:'PLAY DEMO',path:'site-nav/play'}))
  }:info(null,true)});
 assert.equal(selected.frame,child);
 assert.equal(selected.data.metadata.opaqueCanvas,true);
 assert.ok(framePriority(info(null,true),{embedded:true})>framePriority(info('PLAY DEMO')));
});

test('crop only when frame viewport and output JPEG coordinates match',async()=>{
 const child={frameElement:async()=>({boundingBox:async()=>({x:10,y:20,width:800,height:600})}),evaluate:async()=>({width:800,height:600})};
 const parent={};const page={mainFrame:()=>parent,viewportSize:()=>({width:1280,height:720})};
 const okay=await screenshotBox(page,child);assert.equal(okay.aligned,true);assert.equal(okay.clip.width,800);
 child.frameElement=async()=>({boundingBox:async()=>({x:-100,y:20,width:800,height:600})});
 const clipped=await screenshotBox(page,child);assert.equal(clipped.aligned,false);assert.equal(clipped.clip.width,700);
});
