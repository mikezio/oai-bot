import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AvatarMark, avatarRenderMode, semanticAvatarPaths, type AvatarVectorSpec } from "./AvatarMark.js";

const base={id:"pixel",name:"Pixel",color:"#F59E5B",avatarColor:"#F59E5B",avatarAccent:"#FFE0C2",status:"idle"};

test("cat and dog use distinct semantic character geometry at normal avatar markup", () => {
  const cat=renderToStaticMarkup(createElement(AvatarMark,{agent:{...base,avatarShape:"cat"},small:true}));
  const dog=renderToStaticMarkup(createElement(AvatarMark,{agent:{...base,avatarShape:"dog"},small:true}));
  assert.match(cat,/data-avatar-render-mode="semantic"/); assert.match(cat,/cat-character/); assert.match(cat,/animal-whiskers/); assert.match(cat,new RegExp(semanticAvatarPaths.catBody.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  assert.match(dog,/dog-character/); assert.match(dog,/dog-ear/); assert.match(dog,/dog-muzzle/); assert.notEqual(semanticAvatarPaths.catBody,semanticAvatarPaths.dogHead);
});

test("renders every safe vector layer as the avatar itself with independently phased motion", () => {
  const vector:AvatarVectorSpec={version:1,name:"Orbit",layers:[
    {id:"body",kind:"path",role:"body",d:"M20 80Q50 10 80 80Z",fill:"primary",motion:"breathe"},
    {id:"eye",kind:"circle",role:"face",cx:50,cy:48,r:5,fill:"ink",motion:"blink"}
  ]};
  const html=renderToStaticMarkup(createElement(AvatarMark,{agent:{...base,avatarShape:"vector",avatarVector:vector}}));
  assert.equal(avatarRenderMode("vector",vector),"vector"); assert.match(html,/data-avatar-render-mode="vector"/); assert.match(html,/layer-motion-breathe/); assert.match(html,/layer-motion-blink/); assert.doesNotMatch(html,/<img|emoji|group-avatar/);
});
