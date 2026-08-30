import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAvatarVectorSpec, normalizedAvatarState } from "./avatar.js";
import type { AgentProfile } from "./types.js";

function agent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return { id:"one",name:"One",title:"",description:"",instructions:"",avatar:"O",color:"#123456",model:"gpt-5.6-terra",effort:"medium",networkAccess:true,status:"idle",roomThreadIds:{},roomLastSeenMessageIds:{},createdAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z",...overrides };
}

test("normalizes a safe layered vector character without executable markup", () => {
  const value = normalizeAvatarVectorSpec({ version:1,name:"Moon cat",layers:[
    {id:"body",kind:"path",role:"body",d:"M20 80 Q50 10 80 80 Z",fill:"primary",motion:"breathe"},
    {id:"eye",kind:"circle",role:"face",cx:40,cy:45,r:4,fill:"ink",motion:"blink",opacity:.9}
  ]});
  assert.equal(value.version,1); assert.equal(value.name,"Moon cat"); assert.equal(value.layers.length,2);
  assert.deepEqual(value.layers[1],{id:"eye",kind:"circle",role:"face",fill:"ink",motion:"blink",opacity:.9,cx:40,cy:45,r:4});
});

test("rejects unsafe or structurally invalid vector character data", () => {
  assert.throws(()=>normalizeAvatarVectorSpec({version:1,name:"Bad",layers:[{id:"body",kind:"path",role:"body",d:"M0 0 <script>",fill:"primary"}]}),/invalid path data/);
  assert.throws(()=>normalizeAvatarVectorSpec({version:1,name:"Huge",layers:[{id:"body",kind:"path",role:"body",d:"M0 0L1e999 20Z",fill:"primary"}]}),/numeric limits/);
  assert.throws(()=>normalizeAvatarVectorSpec({version:1,name:"No body",layers:[{id:"eye",kind:"circle",role:"face",cx:50,cy:50,r:4,fill:"ink"}]}),/body layer/);
  assert.throws(()=>normalizeAvatarVectorSpec({version:2,name:"Future",layers:[]}),/version must be 1/);
});

test("saved avatar state distinguishes semantic presets from display-only custom labels", () => {
  const custom=normalizedAvatarState(agent({avatarShape:"custom",avatarShapeName:"Cat",avatarMorph:Array(24).fill(1)}));
  assert.equal(custom.semanticVerified,false); assert.match(custom.capability,/display-only/); assert.equal(custom.shapeName,"Cat");
  const cat=normalizedAvatarState(agent({avatarShape:"cat"}));
  assert.equal(cat.semanticVerified,true); assert.match(cat.capability,/supported deterministic semantic/);
});
