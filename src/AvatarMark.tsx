import { useId, useMemo, type CSSProperties, type SVGProps } from "react";
import { motion, useReducedMotion } from "motion/react";

export const avatarShapes = ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop", "cat", "dog"] as const;
export type AvatarShape = typeof avatarShapes[number] | "custom" | "vector";
export type AvatarPaint = "primary" | "accent" | "ink" | "white" | "none";
export type AvatarVectorLayer = { id:string; kind:"path"|"ellipse"|"circle"; role:"body"|"feature"|"face"|"accessory"; d?:string; cx?:number; cy?:number; rx?:number; ry?:number; r?:number; fill:AvatarPaint; stroke?:AvatarPaint; strokeWidth?:number; opacity?:number; motion?:"none"|"breathe"|"float"|"sway"|"blink" };
export type AvatarVectorSpec = { version:1; name:string; layers:AvatarVectorLayer[] };

type Point = {x:number;y:number};

function superellipseRadius(angle:number, rx:number, ry:number, exponent:number) {
  return Math.pow(Math.pow(Math.abs(Math.cos(angle))/rx,exponent)+Math.pow(Math.abs(Math.sin(angle))/ry,exponent),-1/exponent);
}

function shapePoints(shape:AvatarShape,morph?:number[]) {
  const count=24;
  return Array.from({length:count},(_,index):Point=>{
    const angle=-Math.PI/2+(index/count)*Math.PI*2;
    let radius=superellipseRadius(angle,42,42,2.4);
    let xScale=1,xOffset=0,yOffset=0;
    if(shape==="custom"&&morph?.length===24) radius=40*Math.max(.45,Math.min(1.55,morph[index]));
    if(shape==="blob") radius*=1+.055*Math.sin(angle*3+.6)+.035*Math.sin(angle*5);
    if(shape==="pebble") radius=superellipseRadius(angle,43,38,3.3);
    if(shape==="squircle") radius=superellipseRadius(angle,43,43,4.7);
    if(shape==="tablet") radius=superellipseRadius(angle,35,46,5.2);
    if(shape==="hex") radius=39*Math.cos(Math.PI/6)/Math.cos(((angle+Math.PI/6)%(Math.PI/3)+Math.PI/3)%(Math.PI/3)-Math.PI/6);
    if(shape==="cloud") { radius=37*(1+.105*Math.cos(angle*6)); yOffset=4; }
    if(shape==="wedge") { radius=superellipseRadius(angle,42,41,3.4); xScale=.78+.27*((Math.sin(angle)+1)/2); xOffset=3; }
    if(shape==="teardrop") { radius=superellipseRadius(angle,42,43,2.5); xScale=.34+.66*((Math.sin(angle)+1)/2); yOffset=2; }
    return {x:50+xOffset+Math.cos(angle)*radius*xScale,y:50+yOffset+Math.sin(angle)*radius};
  });
}

function smoothClosedPath(points:Point[]) {
  const n=points.length;
  let result=`M${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for(let index=0;index<n;index+=1){
    const p0=points[(index-1+n)%n],p1=points[index],p2=points[(index+1)%n],p3=points[(index+2)%n];
    result+=`C${(p1.x+(p2.x-p0.x)/6).toFixed(2)} ${(p1.y+(p2.y-p0.y)/6).toFixed(2)} ${(p2.x-(p3.x-p1.x)/6).toFixed(2)} ${(p2.y-(p3.y-p1.y)/6).toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return `${result}Z`;
}

const abstractShapes = avatarShapes.filter((shape)=>shape!=="cat"&&shape!=="dog");
const paths=Object.fromEntries(abstractShapes.map(shape=>[shape,smoothClosedPath(shapePoints(shape))])) as Record<string,string>;

export const semanticAvatarPaths = {
  catBody: "M18 46C18 31 22 20 30 12L40 24C46 21 54 21 60 24L70 12C78 20 82 31 82 46C82 69 68 85 50 85C32 85 18 69 18 46Z",
  catLeftEar: "M24 30L30 17L38 27Z", catRightEar: "M62 27L70 17L76 30Z",
  dogHead: "M23 40C23 24 34 16 50 16C66 16 77 24 77 40V61C77 77 66 86 50 86C34 86 23 77 23 61Z",
  dogLeftEar: "M28 24C15 20 9 30 13 48C15 57 21 61 27 56L35 30Z", dogRightEar: "M72 24C85 20 91 30 87 48C85 57 79 61 73 56L65 30Z"
} as const;

function hashIndex(value: string, length: number) { let hash=0; for(let i=0;i<value.length;i+=1) hash=((hash<<5)-hash+value.charCodeAt(i))|0; return Math.abs(hash)%length; }
export function defaultAvatarShape(id:string):AvatarShape { return abstractShapes[hashIndex(id,abstractShapes.length)]; }
export function avatarRenderMode(shape:AvatarShape,vector?:AvatarVectorSpec) { return shape==="cat"||shape==="dog"?"semantic":shape==="vector"&&vector?.version===1?"vector":"procedural"; }

type AvatarAgent = {id:string;name:string;avatar?:string;color?:string;avatarColor?:string;avatarAccent?:string;avatarShape?:AvatarShape;avatarShapeName?:string;avatarMorph?:number[];avatarVector?:AvatarVectorSpec;avatarDataUrl?:string;avatarFace?:"dots"|"visor"|"spark"|"none";avatarTexture?:"solid"|"gradient"|"glass";avatarMotion?:"calm"|"lively"|"off";avatarAccessory?:"none"|"antenna"|"halo"|"headphones"|"crown";status?:string;isComposingMessage?:boolean;activity?:{kind?:string;tool?:string}};

function VectorLayer({layer,index,fillId,color,accent}:{layer:AvatarVectorLayer;index:number;fillId:string;color:string;accent:string}) {
  const paint=(token:AvatarPaint|undefined,stroke=false)=>token==="primary"?(stroke?color:`url(#${fillId})`):token==="accent"?accent:token==="ink"?"#121216":token==="white"?"#FFFFFF":token==="none"?"none":undefined;
  const common = { className:`avatar-vector-layer role-${layer.role} layer-motion-${layer.motion||"none"}`, fill:paint(layer.fill), stroke:paint(layer.stroke,true), strokeWidth:layer.strokeWidth, opacity:layer.opacity, style:{"--layer-delay":`${-(index*.37+.13)}s`} as CSSProperties };
  if(layer.kind==="path") return <path {...common as SVGProps<SVGPathElement>} d={layer.d}/>;
  if(layer.kind==="circle") return <circle {...common as SVGProps<SVGCircleElement>} cx={layer.cx} cy={layer.cy} r={layer.r}/>;
  return <ellipse {...common as SVGProps<SVGEllipseElement>} cx={layer.cx} cy={layer.cy} rx={layer.rx} ry={layer.ry}/>;
}

function SemanticBody({d,fill,imageHref,clipId,glass}:{d:string;fill:string;imageHref?:string;clipId:string;glass:boolean}) {
  return <>{imageHref?<image href={imageHref} width="100" height="100" preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`}/>:<path className="avatar-shape avatar-body-layer" d={d} fill={fill}/>} {glass&&<path className="avatar-glass" d={d}/>}</>;
}

function SemanticCharacter({shape,fill,accent,imageHref,clipId,glass}:{shape:"cat"|"dog";fill:string;accent:string;imageHref?:string;clipId:string;glass:boolean}) {
  if(shape==="cat") return <g className="semantic-character cat-character">
    <path className="animal-ear animal-ear-left" d={semanticAvatarPaths.catLeftEar} fill={accent}/><path className="animal-ear animal-ear-right" d={semanticAvatarPaths.catRightEar} fill={accent}/>
    <SemanticBody d={semanticAvatarPaths.catBody} fill={fill} imageHref={imageHref} clipId={clipId} glass={glass}/><path className="animal-inner-ear" d="M27 27L30 19L35 27ZM65 27L70 19L73 27Z" fill={accent}/>
    <g className="animal-face cat-face"><ellipse cx="38" cy="48" rx="4" ry="5.5"/><ellipse cx="62" cy="48" rx="4" ry="5.5"/><path d="M46 60L50 57L54 60L50 64Z"/><path className="animal-whiskers" d="M44 62L23 58M44 66L21 68M56 62L77 58M56 66L79 68"/></g>
  </g>;
  return <g className="semantic-character dog-character">
    <path className="animal-ear animal-ear-left dog-ear" d={semanticAvatarPaths.dogLeftEar} fill={accent}/><path className="animal-ear animal-ear-right dog-ear" d={semanticAvatarPaths.dogRightEar} fill={accent}/><SemanticBody d={semanticAvatarPaths.dogHead} fill={fill} imageHref={imageHref} clipId={clipId} glass={glass}/>
    <g className="animal-face dog-face"><ellipse cx="38" cy="45" rx="4" ry="5.5"/><ellipse cx="62" cy="45" rx="4" ry="5.5"/><ellipse className="dog-muzzle" cx="50" cy="64" rx="16" ry="12" fill={accent}/><path d="M44 59Q50 54 56 59Q55 65 50 66Q45 65 44 59Z"/><path className="animal-mouth" d="M50 66V70M42 70Q50 78 58 70"/></g>
  </g>;
}

export function AvatarMark({agent,small=false,large=false,preview=false}:{agent:AvatarAgent;small?:boolean;large?:boolean;preview?:boolean}) {
  const instanceId=useId().replace(/[^a-zA-Z0-9_-]/g,""); const reducedMotion=useReducedMotion();
  const shape=agent.avatarShape||defaultAvatarShape(agent.id||agent.name); const mode=avatarRenderMode(shape,agent.avatarVector);
  const bodyPath=useMemo(()=>shape==="cat"?semanticAvatarPaths.catBody:shape==="dog"?semanticAvatarPaths.dogHead:shape==="custom"&&agent.avatarMorph?.length===24?smoothClosedPath(shapePoints("custom",agent.avatarMorph)):paths[shape]||paths.blob,[shape,agent.avatarMorph]);
  const state=preview?"idle":agent.status==="waiting"?"waiting":agent.status==="working"?(agent.activity?.kind==="tool"?"working":agent.isComposingMessage?"writing":"thinking"):"idle";
  const color=agent.avatarColor||agent.color||"#777777",accent=agent.avatarAccent||"#FFFFFF",motionLevel=agent.avatarMotion||"lively",texture=agent.avatarTexture||"gradient",face=agent.avatarFace||"dots",accessory=agent.avatarAccessory||"none";
  const seed=hashIndex(agent.id||agent.name,10_000); const style={"--avatar-color":color,"--avatar-accent":accent,"--avatar-speed":motionLevel==="calm"?"1.65":"1","--avatar-delay":`${-(seed%5200)/1000}s`,"--avatar-feature-delay":`${-((seed*7)%4100)/1000}s`,"--avatar-blink":`${4.1+(seed%240)/100}s`} as CSSProperties;
  const clipId=`avatar-${String(agent.id||agent.name).replace(/[^a-zA-Z0-9_-]/g,"")}-${shape}-${instanceId}`,fillId=`${clipId}-fill`;
  const transition=reducedMotion||motionLevel==="off"?{duration:0}:{type:"spring" as const,stiffness:motionLevel==="calm"?90:155,damping:18,mass:.75}; const fill=texture==="solid"?color:`url(#${fillId})`;
  return <span className={`avatar avatar-mark texture-${texture} motion-${motionLevel} ${small?"small":""} ${large?"large":""}`} data-avatar-state={state} data-avatar-shape={shape} data-avatar-render-mode={mode} style={style} aria-label={`${agent.name} avatar`}>
    <svg viewBox="0 0 100 100" role="img" aria-hidden="true"><defs><clipPath id={clipId}><motion.path initial={false} animate={{d:bodyPath}} transition={transition}/></clipPath><linearGradient id={fillId} x1="15%" y1="10%" x2="88%" y2="92%"><stop offset="0" stopColor={accent}/><stop offset=".32" stopColor={color}/><stop offset="1" stopColor={color}/></linearGradient></defs>
      <g className="avatar-character">
        {mode==="semantic"?<SemanticCharacter shape={shape as "cat"|"dog"} fill={fill} accent={accent} imageHref={agent.avatarDataUrl} clipId={clipId} glass={texture==="glass"}/>:mode==="vector"?agent.avatarVector!.layers.map((layer,index)=><VectorLayer key={layer.id} layer={layer} index={index} fillId={fillId} color={color} accent={accent}/>):<>{agent.avatarDataUrl?<image href={agent.avatarDataUrl} width="100" height="100" preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`}/>:<motion.path className="avatar-shape avatar-body-layer" initial={false} animate={{d:bodyPath}} transition={transition} fill={fill}/>} {texture==="glass"&&<motion.path className="avatar-glass" initial={false} animate={{d:bodyPath}} transition={transition}/>} {face==="dots"&&<g className="avatar-face"><ellipse cx="39" cy="48" rx="4.3" ry="6"/><ellipse cx="61" cy="48" rx="4.3" ry="6"/></g>}{face==="visor"&&<g className="avatar-face avatar-visor"><rect x="30" y="42" width="40" height="13" rx="6.5"/><circle cx="40" cy="48.5" r="2"/><circle cx="60" cy="48.5" r="2"/></g>}{face==="spark"&&<g className="avatar-face avatar-spark"><path d="M39 39l2.5 6.5L48 48l-6.5 2.5L39 57l-2.5-6.5L30 48l6.5-2.5L39 39Zm22 3 1.8 4.2L67 48l-4.2 1.8L61 54l-1.8-4.2L55 48l4.2-1.8L61 42Z"/></g>}</>}
        {accessory==="antenna"&&<g className="avatar-accessory antenna"><path d="M50 15V5"/><circle cx="50" cy="4" r="4"/></g>}{accessory==="halo"&&<ellipse className="avatar-accessory halo" cx="50" cy="12" rx="22" ry="6"/>}{accessory==="headphones"&&<g className="avatar-accessory headphones"><path d="M18 53V43c0-18 14-31 32-31s32 13 32 31v10"/><rect x="12" y="48" width="11" height="22" rx="5"/><rect x="77" y="48" width="11" height="22" rx="5"/></g>}{accessory==="crown"&&<path className="avatar-accessory crown" d="M31 20l4-15 15 11L64 5l5 15Z"/>}
      </g></svg>
  </span>;
}
