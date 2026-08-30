import { Children, cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type CSSProperties, type TouchEvent as ReactTouchEvent } from "react";
import { ArrowDown, ArrowLeft, Bot, Check, ChevronDown, CircleStop, Clock3, Files, LoaderCircle, MessageCircleReply, Monitor, Moon, Paperclip, Play, Plus, RefreshCw, Send, Settings2, ShieldAlert, SmilePlus, Sun, Trash2, Users, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { AvatarMark, type AvatarVectorSpec } from "./AvatarMark";
import { useTheme } from "./theme";
import { sendJournal, type SendJournalEntry } from "./sendJournal";

type Agent = { id:string; name:string; title:string; description:string; instructions:string; memories?:Array<{id:string;text:string;createdAt:string;updatedAt:string}>; avatar:string; color:string; avatarShape?:any; avatarShapeName?:string; avatarMorph?:number[]; avatarVector?:AvatarVectorSpec; avatarColor?:string; avatarAccent?:string; avatarDataUrl?:string; avatarFace?:"dots"|"visor"|"spark"|"none"; avatarTexture?:"solid"|"gradient"|"glass"; avatarMotion?:"calm"|"lively"|"off"; avatarAccessory?:"none"|"antenna"|"halo"|"headphones"|"crown"; model:string; effort:string; networkAccess:boolean; status:string; isComposingMessage?:boolean; isRetrying?:boolean; awaitingUserResponse?:boolean; activity?:{kind:string;tool?:string;detail?:string;target?:string;callId?:string} };
type Room = { id:string; name:string; description:string; agentIds:string[]; kind?:"group"|"direct"; directAgentId?:string; updatedAt?:string; runState?:{nonce:string;phase:"active"|"winding-down"|"waiting";activeAgentId?:string} };
type Attachment = { id:string; name:string; path:string; size:number; mimeType:string };
type Message = { id:string; roomId:string; senderType:string; senderId:string; fromAgentId?:string; toAgentIds?:string[]; content:string; kind:string; status:string; mentions:string[]; replyTo?:string; clientNonce?:string; attachments?:Attachment[]; reactions?:Record<string,string[]>; createdAt:string; updatedAt?:string };
type Approval = { id:string; roomId?:string; agentId?:string; title:string; detail:string };
type Routine = { id:string; roomId:string; agentId:string; name:string; instruction:string; intervalMinutes:number; isEnabled:boolean; lastRunAt?:string; nextRunAt?:string };
type TranscriptMetadata = { agentId:string; generation:string; updatedSeq:number; updatedAt:string };
type TranscriptEntry = { agentId:string; generation:number|string; entryId:string; messageId?:string; entryKind:string; body?:string; deleted?:boolean; seq:number; updatedSeq:number; createdAt:string; updatedAt:string };
type MemberTurn = { id:string; roomId:string; memberAgentId:string; state:string; updatedAt:string };
type DeliveryReceipt = { id:string; messageId:string; status:string; delivery?:string; updatedAt:string };
type AgentClientState = { agentId:string; unreadCount:number; hiddenFromSidebar:boolean; lastViewedAt?:string; updatedAt:string };
type State = { agents:Agent[]; rooms:Room[]; messages:Message[]; approvals:Approval[]; routines:Routine[]; transcriptMetadata:TranscriptMetadata[]; transcriptEntries:TranscriptEntry[]; memberTurns:MemberTurn[]; deliveryReceipts:DeliveryReceipt[]; agentClientStates:AgentClientState[]; account:any; workspace?:string; appVersion?:string };
type CollectionDelta<T> = { upsert:T[]; remove:string[] };

const API = "";

function messageSource():"desktop"|"mobile" {
  return window.matchMedia("(max-width: 760px), (pointer: coarse)").matches ? "mobile" : "desktop";
}

async function request(url:string, options?:RequestInit) {
  const response = await fetch(`${API}${url}`, { ...options, headers: { "Content-Type":"application/json", ...(options?.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

async function sendPromptDurably(payload:Record<string,unknown>) {
  try {
    return await request("/api/sendPrompt", {method:"POST",body:JSON.stringify(payload)});
  } catch (firstError) {
    try {
      const acceptance = await request("/api/promptAcceptanceStatus", {method:"POST",body:JSON.stringify({agentId:payload.agentId,clientNonce:payload.clientNonce})});
      if (acceptance.outcome === "found" && ["accepted","pending"].includes(acceptance.record?.status)) return acceptance.record;
      if (acceptance.outcome === "found" && acceptance.record?.status === "rejected") throw new Error(`Message was rejected${acceptance.record.rejectionCode?`: ${acceptance.record.rejectionCode}`:""}`);
      return await request("/api/sendPrompt", {method:"POST",body:JSON.stringify(payload)});
    } catch {
      throw firstError;
    }
  }
}

function applyCollectionDelta<T extends {id:string}>(current:T[], delta?:CollectionDelta<T>) {
  if (!delta) return current;
  const updates = new Map(delta.upsert.map(item => [item.id,item]));
  const removed = new Set(delta.remove);
  const next = current.filter(item => !removed.has(item.id)).map(item => updates.get(item.id) || item);
  for (const item of delta.upsert) if (!current.some(existing => existing.id === item.id)) next.push(item);
  return next;
}

function applyKeyedCollectionDelta<T>(current:T[], delta:CollectionDelta<T>|undefined, key:(item:T)=>string) {
  if (!delta) return current;
  const updates = new Map(delta.upsert.map(item => [key(item),item]));
  const removed = new Set(delta.remove);
  const next = current.filter(item => !removed.has(key(item))).map(item => updates.get(key(item)) || item);
  for (const item of delta.upsert) if (!current.some(existing => key(existing) === key(item))) next.push(item);
  return next;
}

function normalizeState(next:any):State {
  return {
    ...next,
    agents: next.agents || [], rooms: next.rooms || [], messages: next.messages || [], approvals: next.approvals || [], routines: next.routines || [],
    transcriptMetadata: next.transcriptMetadata || [], transcriptEntries: next.transcriptEntries || [], memberTurns: next.memberTurns || [], deliveryReceipts: next.deliveryReceipts || [], agentClientStates: next.agentClientStates || [],
    account: next.account || {}
  };
}

function firstVisibleRoomId(state:State) {
  const clientStates = new Map(state.agentClientStates.map((item) => [item.agentId,item]));
  return state.rooms.find((room) => room.kind !== "direct" || !room.directAgentId || !clientStates.get(room.directAgentId)?.hiddenFromSidebar)?.id || "";
}

function compactMessageText(value:string, limit=78) {
  const clean=value
    .replace(/```[\s\S]*?```/g," shared code ")
    .replace(/[`*_>#\[\]]/g,"")
    .replace(/\s+/g," ")
    .trim();
  return clean.length>limit?`${clean.slice(0,limit-1).trimEnd()}…`:clean;
}

function Avatar({agent, small=false}:{agent:Agent; small?:boolean}) {
  return <AvatarMark agent={agent} small={small}/>;
}

export function App() {
  const [state, setState] = useState<State>({agents:[],rooms:[],messages:[],approvals:[],routines:[],transcriptMetadata:[],transcriptEntries:[],memberTurns:[],deliveryReceipts:[],agentClientStates:[],account:{}});
  const [roomId, setRoomId] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [modal, setModal] = useState<"agent"|"room"|"routine"|null>(null);
  const [editing, setEditing] = useState<Agent|null>(null);
  const [editingRoom, setEditingRoom] = useState<Room|null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [workspaceFiles, setWorkspaceFiles] = useState<any[]>([]);
  const [replyTo, setReplyTo] = useState<Message|null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [newActivityBelow, setNewActivityBelow] = useState(false);
  const [composerHeight, setComposerHeight] = useState(40);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [swipeDragging, setSwipeDragging] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const markingReadRef = useRef(new Set<string>());
  const navInstantRef = useRef(true);
  const swipeRef = useRef<{active:boolean;startX:number;startY:number;locked:"h"|"v"|null}>({active:false,startX:0,startY:0,locked:null});
  const mobileChatOpenRef = useRef(mobileChatOpen);
  mobileChatOpenRef.current = mobileChatOpen;

  function isPhoneNav() {
    return window.matchMedia("(max-width: 720px)").matches;
  }

  function openChat(id: string) {
    setRoomId(id);
    setReplyTo(null);
    setDetailsOpen(false);
    setFilesOpen(false);
    setSwipeOffset(0);
    setMobileChatOpen(true);
    navInstantRef.current = false;
    if (isPhoneNav() && window.history.state?.oaiScreen !== "chat") {
      window.history.pushState({oaiScreen:"chat",roomId:id}, "");
    }
  }

  function closeChat() {
    navInstantRef.current = false;
    setSwipeOffset(0);
    setSwipeDragging(false);
    if (isPhoneNav() && window.history.state?.oaiScreen === "chat") {
      window.history.back();
      return;
    }
    setMobileChatOpen(false);
    setDetailsOpen(false);
    setFilesOpen(false);
  }

  function resizeComposer(value = draft) {
    const node = composerRef.current;
    if (!node) return;
    node.style.height = "0px";
    const next = Math.min(140, Math.max(40, node.scrollHeight));
    node.style.height = `${next}px`;
    setComposerHeight(next);
    void value;
  }

  useEffect(() => {
    const reconcile=(serverMessages:Message[],optimistic:Message[]=[])=>{
      const authoritative=serverMessages.filter(message=>!message.id.startsWith("optimistic:"));
      sendJournal.reconcileTranscript(authoritative);
      const echoed=new Set(authoritative.map(message=>message.clientNonce).filter(Boolean));
      const pending=new Map([...serverMessages,...optimistic].filter(message=>message.id.startsWith("optimistic:")&&!echoed.has(message.clientNonce)).map(message=>[message.id,message]));
      return [...authoritative,...pending.values()];
    };
    request("/api/state").then((raw) => { const next=normalizeState(raw); setState(current=>({...next,messages:reconcile(next.messages,current.messages)})); setRoomId((id) => id || firstVisibleRoomId(next)); }).catch((e) => setError(e.message));
    const events = new EventSource(`${API}/api/events`);
    events.onmessage = (event) => {
      const next = JSON.parse(event.data);
      if (next.type === "snapshot") {
        const snapshot=normalizeState(next.state);
        setState(current=>({...snapshot,messages:reconcile(snapshot.messages,current.messages)}));
        setRoomId((id) => id || firstVisibleRoomId(snapshot));
      } else if (next.type === "delta") {
        setState((current) => {
          const nextMessages=applyCollectionDelta(current.messages,next.messages);
          return {
          ...current,
          agents: applyCollectionDelta(current.agents,next.agents),
          rooms: applyCollectionDelta(current.rooms,next.rooms),
          messages: reconcile(nextMessages,current.messages),
          approvals: applyCollectionDelta(current.approvals,next.approvals),
          routines: applyCollectionDelta(current.routines,next.routines),
          transcriptMetadata: applyKeyedCollectionDelta(current.transcriptMetadata,next.transcriptMetadata,(item)=>item.agentId),
          transcriptEntries: applyKeyedCollectionDelta(current.transcriptEntries,next.transcriptEntries,(item)=>`${item.agentId}:${item.generation}:${item.entryId}`),
          memberTurns: applyCollectionDelta(current.memberTurns,next.memberTurns),
          deliveryReceipts: applyCollectionDelta(current.deliveryReceipts,next.deliveryReceipts),
          agentClientStates: applyKeyedCollectionDelta(current.agentClientStates,next.agentClientStates,(item)=>item.agentId),
          account: next.account || current.account
        }});
      }
    };
    return () => events.close();
  }, []);

  useEffect(()=>{
    const resume=async(entry:SendJournalEntry)=>{
      try {
        if(entry.phase==="accepted-awaiting-echo") {
          const acceptance=await request("/api/promptAcceptanceStatus",{method:"POST",body:JSON.stringify({agentId:entry.payload.agentId,clientNonce:entry.clientNonce})});
          if(acceptance.outcome==="found"&&acceptance.record?.status==="rejected"&&sendJournal.get(entry.clientNonce)) sendJournal.markFailed(entry.clientNonce,acceptance.record.rejectionCode||"Rejected");
          return;
        }
        if(entry.phase==="failed") { setDraft(value=>value||entry.draft); return; }
        if(entry.phase==="prepared") sendJournal.queue(entry.clientNonce);
        sendJournal.beginDispatch(entry.clientNonce);
        const receipt=await sendPromptDurably(entry.payload);
        if(sendJournal.get(entry.clientNonce)) sendJournal.markAccepted(entry.clientNonce,receipt.acceptedAtMs||Date.now());
      } catch(error) {
        if(sendJournal.get(entry.clientNonce)) sendJournal.markFailed(entry.clientNonce,error);
        setDraft(value=>value||entry.draft);
      }
    };
    for(const entry of sendJournal.restorePending()) void resume(entry);
  },[]);

  const room = state.rooms.find((item) => item.id === roomId);
  const roomAgents = state.agents.filter((agent) => room?.agentIds.includes(agent.id));
  const messages = state.messages.filter((message) => message.roomId === roomId);
  const names = useMemo(() => new Map(state.agents.map((agent) => [agent.id,agent])), [state.agents]);
  const pending = state.approvals.filter((approval) => approval.roomId === roomId);
  const canSend = (draft.trim() || attachments.length) && state.account?.connected && state.account?.authMode === "chatgpt";
  const clientStates = useMemo(() => new Map(state.agentClientStates.map((item) => [item.agentId,item])), [state.agentClientStates]);
  const chats = useMemo(() => state.rooms
    .filter((item) => item.kind !== "direct" || !item.directAgentId || !clientStates.get(item.directAgentId)?.hiddenFromSidebar)
    .sort((a,b) => String(b.updatedAt||"").localeCompare(String(a.updatedAt||""))), [state.rooms,clientStates]);
  const channels=chats.filter(item=>item.kind!=="direct");
  const botChats=chats.filter(item=>item.kind==="direct");
  const mentionQuery = draft.match(/(?:^|\s)@([^\s@]*)$/)?.[1]?.toLowerCase();
  const mentionChoices = mentionQuery === undefined ? [] : roomAgents.filter(agent => agent.name.toLowerCase().startsWith(mentionQuery));
  const workingAgents = roomAgents.filter(agent => agent.status === "working" || room?.runState?.activeAgentId === agent.id);

  useEffect(() => {
    const agentId = room?.kind === "direct" ? room.directAgentId : undefined;
    if (!agentId || !clientStates.get(agentId)?.unreadCount || markingReadRef.current.has(agentId)) return;
    markingReadRef.current.add(agentId);
    request(`/api/agents/${agentId}/client-state`, {method:"PATCH",body:JSON.stringify({markRead:true})})
      .catch((e) => setError(e.message))
      .finally(() => markingReadRef.current.delete(agentId));
  }, [room?.id,room?.kind,room?.directAgentId,clientStates]);

  useEffect(() => {
    const transcript=transcriptRef.current;
    if(!transcript)return;
    const distanceFromBottom=transcript.scrollHeight-transcript.scrollTop-transcript.clientHeight;
    if(distanceFromBottom>180){setNewActivityBelow(true);return;}
    const reducedMotion=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    transcript.scrollTo({top:transcript.scrollHeight,behavior:reducedMotion?"auto":"smooth"});
    setNewActivityBelow(false);
  }, [messages.length, messages.at(-1)?.content]);

  useEffect(() => {
    const transcript=transcriptRef.current;
    if(!transcript)return;
    const frame=requestAnimationFrame(()=>transcript.scrollTo({top:transcript.scrollHeight,behavior:"auto"}));
    setNewActivityBelow(false);
    return()=>cancelAnimationFrame(frame);
  }, [roomId]);

  useEffect(()=>{
    const onKeyDown=(event:KeyboardEvent)=>{
      if((event.metaKey||event.ctrlKey)&&event.shiftKey&&event.key.toLowerCase()==="i"&&room){event.preventDefault();setDetailsOpen(value=>!value);return;}
      if(event.key!=="Escape")return;
      if(modal){setModal(null);return;}
      if(filesOpen){setFilesOpen(false);return;}
      if(detailsOpen){setDetailsOpen(false);return;}
      if(replyTo)setReplyTo(null);
      if(mobileChatOpen&&window.matchMedia("(max-width: 720px)").matches) closeChat();
    };
    window.addEventListener("keydown",onKeyDown);
    return()=>window.removeEventListener("keydown",onKeyDown);
  },[detailsOpen,filesOpen,modal,replyTo,room,mobileChatOpen]);

  useEffect(()=>{
    if(roomId&&!state.rooms.some(item=>item.id===roomId)) {
      setRoomId(firstVisibleRoomId(state));
      setMobileChatOpen(false);
    }
  },[roomId,state.rooms]);

  useEffect(() => {
    resizeComposer(draft);
  }, [draft]);

  useEffect(() => {
    if (!window.history.state) window.history.replaceState({oaiScreen:"list"}, "");
    const onPop = () => {
      if (!isPhoneNav()) return;
      if (modal) { setModal(null); return; }
      if (filesOpen) { setFilesOpen(false); return; }
      if (detailsOpen) { setDetailsOpen(false); return; }
      setMobileChatOpen(false);
      setDetailsOpen(false);
      setFilesOpen(false);
      setSwipeOffset(0);
      setSwipeDragging(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [modal, filesOpen, detailsOpen]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty("--keyboard-inset", `${inset}px`);
      document.documentElement.style.setProperty("--vv-offset", `${viewport.offsetTop}px`);
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      document.documentElement.style.removeProperty("--keyboard-inset");
      document.documentElement.style.removeProperty("--vv-offset");
    };
  }, []);

  useEffect(() => {
    if (!mobileChatOpen) return;
    const frame = requestAnimationFrame(() => {
      composerRef.current?.blur();
    });
    return () => cancelAnimationFrame(frame);
  }, [roomId]);

  function onChatTouchStart(event: ReactTouchEvent) {
    if (!isPhoneNav() || !mobileChatOpen || detailsOpen || filesOpen || modal) return;
    const touch = event.touches[0];
    if (touch.clientX > 28) return;
    swipeRef.current = {active:true,startX:touch.clientX,startY:touch.clientY,locked:null};
    setSwipeDragging(true);
  }

  function onChatTouchMove(event: ReactTouchEvent) {
    const swipe = swipeRef.current;
    if (!swipe.active) return;
    const touch = event.touches[0];
    const dx = touch.clientX - swipe.startX;
    const dy = touch.clientY - swipe.startY;
    if (!swipe.locked) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      swipe.locked = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      if (swipe.locked === "v") {
        swipe.active = false;
        setSwipeDragging(false);
        setSwipeOffset(0);
        return;
      }
    }
    if (swipe.locked !== "h") return;
    event.preventDefault();
    setSwipeOffset(Math.max(0, Math.min(window.innerWidth, dx)));
  }

  function onChatTouchEnd() {
    const swipe = swipeRef.current;
    if (!swipe.active && !swipeDragging) return;
    const shouldClose = swipeOffset > window.innerWidth * 0.28;
    swipeRef.current = {active:false,startX:0,startY:0,locked:null};
    setSwipeDragging(false);
    if (shouldClose) {
      closeChat();
    } else {
      setSwipeOffset(0);
    }
  }

  async function send() {
    if (!canSend) return;
    const content = draft; const replying = replyTo; const sendingAttachments = attachments; setError("");
    const agentId = room?.kind === "direct" ? room.directAgentId : room?.id;
    let entry:SendJournalEntry|undefined;
    try {
      entry=sendJournal.prepare({payload:{prompt:content,agentId,replyToId:replying?.id,attachmentIds:sendingAttachments.map(item=>item.id),source:messageSource(),composedAtMs:Date.now()},draft:content,attachments:sendingAttachments});
      if(!sendJournal.persistenceStatus().durable) throw new Error(sendJournal.persistenceStatus().error||"Durable message storage is unavailable in this browser");
      sendJournal.queue(entry.clientNonce);
      setDraft(""); setReplyTo(null); setAttachments([]);
      const timestamp=new Date().toISOString();
      const optimistic:Message={id:`optimistic:${entry.clientNonce}`,roomId:room!.id,senderType:"user",senderId:"user",content,kind:"message",status:"complete",mentions:[],replyTo:replying?.id,clientNonce:entry.clientNonce,attachments:sendingAttachments,reactions:{},createdAt:timestamp,updatedAt:timestamp};
      setState(current=>({...current,messages:[...current.messages,optimistic]}));
      sendJournal.beginDispatch(entry.clientNonce);
      const receipt=await sendPromptDurably(entry.payload);
      if(sendJournal.get(entry.clientNonce)) sendJournal.markAccepted(entry.clientNonce,receipt.acceptedAtMs||Date.now());
    }
    catch(e:any) {
      if(entry&&sendJournal.get(entry.clientNonce)) sendJournal.markFailed(entry.clientNonce,e);
      if(entry)setState(current=>({...current,messages:current.messages.filter(message=>message.id!==`optimistic:${entry!.clientNonce}`)}));
      setDraft(content); setReplyTo(replying); setAttachments(sendingAttachments); setError(e.message);
    }
  }

  async function uploadFiles(files:FileList|null) {
    if (!files) return;
    for (const file of Array.from(files).slice(0,8-attachments.length)) {
      try {
        const dataUrl = await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file)});
        const uploaded = await request("/api/attachments",{method:"POST",body:JSON.stringify({filename:file.name,mimeType:file.type,bytesBase64:dataUrl.split(",")[1]})});
        setAttachments(items=>[...items,uploaded]);
      } catch(e:any) { setError(e.message); }
    }
    if(fileInputRef.current) fileInputRef.current.value="";
  }

  function insertMention(name:string) {
    setDraft(value => value.replace(/(?:^|\s)@[^\s@]*$/, match => `${match.startsWith(" ") ? " " : ""}@${name} `));
  }

  async function refreshFiles() {
    setFilesOpen(true);
    try { setWorkspaceFiles((await request("/api/workspace")).files); } catch(e:any) { setError(e.message); }
  }

  function jumpToLatest() {
    const reducedMotion=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const transcript=transcriptRef.current;
    transcript?.scrollTo({top:transcript.scrollHeight,behavior:reducedMotion?"auto":"smooth"});
    setNewActivityBelow(false);
  }

  return <div className={`shell ${mobileChatOpen?"mobile-chat-open":""} ${navInstantRef.current?"nav-instant":""} ${swipeDragging?"nav-dragging":""}`} style={{"--swipe-x":`${swipeOffset}px`} as CSSProperties}>
    <aside className="sidebar">
      <div className="brand"><div className="brandmark"><Bot size={18}/></div><div><strong>OAI Bot</strong><span>AI teammates</span></div></div>
      <section className="side-section grow">
        <div className="section-label"><span>Channels</span><span className="section-actions"><button type="button" title="New Channel" onClick={() => {setEditingRoom(null);setModal("room")}}><Plus size={18}/></button></span></div>
        {!chats.length&&<div className="empty-chats"><Bot size={28}/><strong>Create your first Bot</strong><span>Customize it, talk directly, then add it to Channels.</span><button type="button" onClick={()=>{setEditing(null);setModal("agent")}}>New Bot</button></div>}
        {channels.map((item) => <SidebarChat key={item.id} item={item} roomId={roomId} state={state} names={names} clientStates={clientStates} onOpen={()=>openChat(item.id)}/>)}
        {!!botChats.length&&<div className="section-label bot-section-label"><span>Bots</span><span className="section-actions"><button type="button" title="New Bot" onClick={() => {setEditing(null);setModal("agent")}}><Plus size={18}/></button></span></div>}
        {botChats.map((item) => <SidebarChat key={item.id} item={item} roomId={roomId} state={state} names={names} clientStates={clientStates} onOpen={()=>openChat(item.id)} onEdit={()=>{const agent=item.directAgentId?names.get(item.directAgentId):undefined;if(agent){setEditing(agent);setModal("agent")}}} onDelete={async()=>{const agent=item.directAgentId?names.get(item.directAgentId):undefined;if(!agent||!window.confirm(`Delete ${agent.name}? This permanently removes the Bot and its transcript.`))return;try{await request(`/api/agents/${agent.id}`,{method:"DELETE"})}catch(error:any){setError(error.message)}}}/>)}
      </section>
      <Account account={state.account} version={state.appVersion} onRefresh={async()=>{const next=await request("/api/account/refresh",{method:"POST"});setState(s=>({...s,account:next}))}} />
    </aside>

    <main
      className={`chat ${detailsOpen?"details-visible":""}`}
      onTouchStart={onChatTouchStart}
      onTouchMove={onChatTouchMove}
      onTouchEnd={onChatTouchEnd}
      onTouchCancel={onChatTouchEnd}
    >
      <header className="chat-header">
        <button type="button" className="mobile-back" title="Back to chats" onClick={closeChat}><ArrowLeft size={22}/></button>
        <button type="button" className="header-title" onClick={()=>room&&setDetailsOpen(value=>!value)} title={room?"Open conversation info":undefined}>{room?.kind==="direct"&&roomAgents[0]?<Avatar agent={roomAgents[0]}/>:<span className="group-avatar"><Users size={16}/></span>}<span><h1>{room?.name || "Choose a Bot or Channel"}</h1><p>{room?.runState?.phase==="waiting"?"Waiting for you":room?.kind==="group"?`${roomAgents.length} Bots`:room?.description}</p></span></button>
        <div className="header-actions">{room?.runState?.phase==="active"&&<button type="button" className="icon-button stop-button" onClick={()=>request(`/api/agents/${room.kind==="direct"?room.directAgentId:room.id}/interrupt`,{method:"POST"}).catch(e=>setError(e.message))} title="Stop"><CircleStop size={20}/></button>}{room&&<button type="button" className={`icon-button ${detailsOpen?"active":""}`} onClick={()=>setDetailsOpen(value=>!value)} title="Conversation info"><Settings2 size={18}/></button>}<button type="button" className="icon-button" onClick={refreshFiles} title="Shared workspace"><Files size={18}/></button></div>
      </header>

      <div className="transcript" ref={transcriptRef} onScroll={event=>{const target=event.currentTarget;setNewActivityBelow(target.scrollHeight-target.scrollTop-target.clientHeight>180)}}>
        {!state.account?.connected && <EmptyAuth account={state.account} setError={setError} onAccount={account=>setState(current=>({...current,account}))}/>}
        {messages.map((message) => <MessageRow key={message.id} room={room} message={message} agent={names.get(message.senderId)} agents={state.agents} allMessages={messages} onReply={setReplyTo} onReact={emoji=>request(`/api/messages/${message.id}/reactions`,{method:"POST",body:JSON.stringify({emoji})})} onOpenAgent={(agentId)=>{const direct=state.rooms.find(r=>r.directAgentId===agentId);if(direct)openChat(direct.id)}}/>) }
        {workingAgents.map(agent => <div className={`activity-line ${agent.activity?.kind==="tool"?"using-tool":"composing"}`} key={agent.id}>
          <span className="activity-agent-mark"><Avatar agent={agent} small/></span>
          <span className="activity-copy"><strong>{room?.kind==="group"?agent.name:""}</strong>{agent.activity?.kind==="tool" ? agent.activity.detail : agent.isComposingMessage ? "Writing" : agent.activity?.detail || "Working"}</span>
        </div>)}
        {pending.map((approval) => <ApprovalCard key={approval.id} approval={approval} onDecision={async decision=>request(`/api/approvals/${approval.id}`,{method:"POST",body:JSON.stringify({decision})})}/>) }
      </div>

      {newActivityBelow&&<button type="button" className="jump-to-latest" onClick={jumpToLatest}><ArrowDown size={14}/>New activity</button>}

      <footer className="composer-wrap" style={{paddingBottom:`max(12px, calc(env(safe-area-inset-bottom) + var(--keyboard-inset, 0px)))`}}>
        {error && <div className="error-banner"><ShieldAlert size={15}/><span>{error}</span><button type="button" onClick={()=>setError("")}><X size={14}/></button></div>}
        {replyTo&&<div className="replying"><MessageCircleReply size={14}/><span>Replying to <strong>{replyTo.senderType==="user"?"yourself":names.get(replyTo.senderId)?.name||"System"}</strong><small>{replyTo.content}</small></span><button type="button" onClick={()=>setReplyTo(null)}><X size={14}/></button></div>}
        {attachments.length>0&&<div className="attachment-tray">{attachments.map(item=><span key={item.id}><Paperclip size={12}/>{item.name}<button type="button" onClick={()=>setAttachments(items=>items.filter(file=>file.id!==item.id))}><X size={12}/></button></span>)}</div>}
        <div className="composer-shell">
          {mentionChoices.length>0&&<div className="mention-menu">{mentionChoices.map(agent=><button type="button" key={agent.id} onClick={()=>insertMention(agent.name)}><Avatar agent={agent} small/><span><strong>@{agent.name}</strong><small>{agent.title}</small></span></button>)}<button type="button" onClick={()=>insertMention("everyone")}><span className="group-avatar small"><Users size={12}/></span><span><strong>@everyone</strong><small>Ask the whole room</small></span></button></div>}
          <div className="composer"><input ref={fileInputRef} className="file-input" type="file" multiple onChange={e=>uploadFiles(e.target.files)}/><button type="button" className="attach-button" title="Attach files" onClick={()=>fileInputRef.current?.click()}><Paperclip size={18}/></button><textarea ref={composerRef} value={draft} rows={1} style={{height:composerHeight}} onChange={e=>{setDraft(e.target.value);resizeComposer(e.target.value)}} placeholder={room?`Message ${room.name}`:"Choose a chat"} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send()}}}/><button type="button" disabled={!canSend} onClick={send} aria-label="Send"><Send size={18}/></button></div>
        </div>
      </footer>
    </main>

    {filesOpen && <WorkspacePanel files={workspaceFiles} root={state.workspace||"shared-workspace"} onClose={()=>setFilesOpen(false)} onRefresh={refreshFiles}/>}
    {detailsOpen&&room?.kind==="group"&&<ConversationDetails room={room} agents={state.agents} routines={state.routines.filter(item=>item.roomId===room.id)} onClose={()=>setDetailsOpen(false)} onSettings={()=>{setEditingRoom(room);setModal("room")}} onCreateRoutine={()=>setModal("routine")} onOpenAgent={agentId=>{const direct=state.rooms.find(r=>r.directAgentId===agentId);if(direct){setDetailsOpen(false);openChat(direct.id)}}}/>}
    {detailsOpen&&room?.kind==="direct"&&roomAgents[0]&&<AgentDetails agent={roomAgents[0]} room={room} rooms={state.rooms} routines={state.routines.filter(item=>item.agentId===roomAgents[0].id)} onClose={()=>setDetailsOpen(false)} onOpenWorkspace={refreshFiles} onSettings={()=>{setEditing(roomAgents[0]);setModal("agent")}} onCreateRoutine={()=>setModal("routine")}/>}
    {modal==="agent" && <AgentModal agent={editing} onClose={()=>setModal(null)} onSaved={()=>setModal(null)}/>}
    {modal==="room" && <RoomModal agents={state.agents} room={editingRoom} onClose={()=>setModal(null)} onDeleted={()=>{setModal(null);setDetailsOpen(false)}} onSaved={(newRoom)=>{setRoomId(newRoom.id);setModal(null)}}/>}
    {modal==="routine"&&room&&<RoutineModal room={room} agents={roomAgents} onClose={()=>setModal(null)} onSaved={()=>setModal(null)}/>}
  </div>;
}

function SidebarChat({item,roomId,state,names,clientStates,onOpen,onEdit,onDelete}:{item:Room;roomId:string;state:State;names:Map<string,Agent>;clientStates:Map<string,AgentClientState>;onOpen:()=>void;onEdit?:()=>void;onDelete?:()=>Promise<void>}) {
  const [menu,setMenu]=useState<{x:number;y:number}|null>(null);
  const longPressRef=useRef<number|null>(null);
  const directAgent=item.directAgentId?names.get(item.directAgentId):undefined;
  const directClientState=item.directAgentId?clientStates.get(item.directAgentId):undefined;
  const latest=[...state.messages].reverse().find(message=>message.roomId===item.id&&message.kind!=="activity");
  const latestAgent=latest?names.get(latest.senderId):undefined;
  let preview=item.description|| (item.kind==="direct"?"Private Bot chat":"Channel");
  if(latest) {
    const text=compactMessageText(latest.content);
    const isInternalDirectHandoff=item.kind==="direct"&&latest.kind==="peer-message"&&latest.senderType==="agent"&&latest.senderId!==item.directAgentId;
    preview=isInternalDirectHandoff
      ? `Bot activity from ${latestAgent?.name||"another Bot"}`
      : `${latest.senderType==="user"?"You":latestAgent?.name||"System"}: ${text||"Working"}`;
  }
  useEffect(()=>{
    if(!menu)return;
    const close=()=>setMenu(null);
    const onKey=(event:KeyboardEvent)=>event.key==="Escape"&&close();
    window.addEventListener("pointerdown",close);
    window.addEventListener("blur",close);
    window.addEventListener("keydown",onKey);
    return()=>{window.removeEventListener("pointerdown",close);window.removeEventListener("blur",close);window.removeEventListener("keydown",onKey)};
  },[menu]);
  useEffect(()=>()=>{if(longPressRef.current)window.clearTimeout(longPressRef.current)},[]);
  function openMenuAt(x:number,y:number) {
    if(!directAgent)return;
    setMenu({x,y});
  }
  return <><button type="button" className={`chat-link ${item.id===roomId?"active":""}`} onClick={onOpen}
    onContextMenu={event=>{if(!directAgent)return;event.preventDefault();openMenuAt(event.clientX,event.clientY)}}
    onTouchStart={event=>{if(!directAgent)return;const touch=event.touches[0];longPressRef.current=window.setTimeout(()=>openMenuAt(touch.clientX,touch.clientY),480)}}
    onTouchEnd={()=>{if(longPressRef.current)window.clearTimeout(longPressRef.current);longPressRef.current=null}}
    onTouchMove={()=>{if(longPressRef.current)window.clearTimeout(longPressRef.current);longPressRef.current=null}}
    aria-haspopup={directAgent?"menu":undefined}>
    {directAgent?<Avatar agent={directAgent}/>:<span className="group-avatar"><Users size={16}/></span>}
    <span className="chat-link-copy"><strong>{item.name}</strong><small>{preview}</small></span>
    {!!directClientState?.unreadCount&&<span className="unread-count" aria-label={`${directClientState.unreadCount} unread message${directClientState.unreadCount===1?"":"s"}`}>{directClientState.unreadCount>99?"99+":directClientState.unreadCount}</span>}
    {directAgent?.status==="working"&&<i className="presence working" aria-hidden="true"/>}
  </button>{menu&&<div className="bot-context-menu" role="menu" style={{left:Math.min(menu.x,window.innerWidth-200),top:Math.min(menu.y,window.innerHeight-120)}} onPointerDown={event=>event.stopPropagation()}><button type="button" role="menuitem" onClick={()=>{setMenu(null);onEdit?.()}}><Settings2 size={16}/>Bot settings</button><button type="button" className="danger" role="menuitem" onClick={()=>{setMenu(null);void onDelete?.()}}><Trash2 size={16}/>Delete Bot…</button></div>}</>;
}

function Account({account,version,onRefresh}:{account:any;version?:string;onRefresh:()=>void}) {
  const theme=useTheme();
  const used = Math.round(account?.primaryUsedPercent || 0);
  const plan = String(account?.planType || "").toLowerCase().startsWith("pro") ? "Pro" : account?.planType || "";
  return <div className={`account-card ${account?.authMode==="chatgpt"?"connected":""}`}>
    <div><span className="account-dot"/><strong>{account?.authMode==="chatgpt"?`ChatGPT ${plan}`:"ChatGPT sign-in needed"}</strong><button onClick={onRefresh}><RefreshCw size={13}/></button></div>
    {account?.authMode==="chatgpt" ? <><p>{account.email || "Managed account"}</p><div className="usage"><span style={{width:`${Math.min(100,used)}%`}}/></div><small>{used}% of current Codex window used</small></> : <p>API-key fallback is off, so turns only use your ChatGPT plan.</p>}
    <div className="theme-switch" aria-label="Appearance">{([['system',Monitor],['light',Sun],['dark',Moon]] as const).map(([value,Icon])=><button key={value} className={theme.preference===value?"active":""} title={`${value[0].toUpperCase()}${value.slice(1)} appearance`} onClick={()=>theme.setPreference(value)}><Icon size={13}/></button>)}</div>
    {version&&<small className="app-version">OAI Bot v{version}</small>}
  </div>
}

function EmptyAuth({account,setError,onAccount}:{account:any;setError:(s:string)=>void;onAccount:(account:any)=>void}) {
  const [signingIn,setSigningIn]=useState(false);
  const runtimeMissing=account?.runtimeAvailable===false;

  async function signIn() {
    setSigningIn(true);
    const loginWindow=window.open("about:blank","oai-bot-chatgpt-login");
    try {
      const result=await request("/api/account/login",{method:"POST"});
      if(result.authUrl) {
        if(loginWindow) loginWindow.location.href=result.authUrl;
        else window.open(result.authUrl,"_blank");
      }
      for(let attempt=0;attempt<60;attempt+=1) {
        await new Promise(resolve=>window.setTimeout(resolve,2000));
        const next=await request("/api/account/refresh",{method:"POST"});
        onAccount(next);
        if(next.connected) {
          loginWindow?.close();
          return;
        }
      }
      setError("Sign-in is still pending. Finish it in the browser, then use the refresh button.");
    } catch(error:any) {
      loginWindow?.close();
      setError(error.message);
    } finally {
      setSigningIn(false);
    }
  }

  if(runtimeMissing) return <div className="empty-auth"><Bot size={30}/><h2>Install Codex to continue</h2><p>OAI Bot could not find a Codex runtime. Install the Codex CLI for your operating system, run <code>codex</code> once, and choose <strong>Sign in with ChatGPT</strong>.</p><a className="auth-action" href="https://learn.chatgpt.com/docs/codex/cli" target="_blank" rel="noreferrer">Open official install instructions</a><small>{account?.error}</small></div>;
  return <div className="empty-auth"><Bot size={30}/><h2>Connect your ChatGPT plan</h2><p>No API key is needed. Continue in your browser with the ChatGPT account whose Codex usage you want OAI Bot to use.</p><button disabled={signingIn} onClick={signIn}>{signingIn?<><LoaderCircle className="spinning" size={15}/> Waiting for sign-in</>:"Sign in with ChatGPT"}</button></div>;
}

function MentionText({text,agents,onOpenAgent}:{text:string;agents:Agent[];onOpenAgent?:(id:string)=>void}) {
  const pattern = new RegExp(`(@(?:${agents.map(a=>a.name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")}))`,"gi");
  return <>{text.split(pattern).map((part,i)=>{
    if(!part.startsWith("@")) return part;
    const matched=agents.find(agent=>agent.name.toLowerCase()===part.slice(1).toLowerCase());
    return matched&&onOpenAgent?<button type="button" className="mention mention-link" key={i} onClick={()=>onOpenAgent(matched.id)}>{part}</button>:<span className="mention" key={i}>{part}</span>;
  })}</>;
}

function MentionNodes({children,agents,onOpenAgent}:{children:any;agents:Agent[];onOpenAgent:(id:string)=>void}):any {
  return Children.map(children,child=>{
    if(typeof child==="string") return <MentionText text={child} agents={agents} onOpenAgent={onOpenAgent}/>;
    if(isValidElement(child)) {
      const nested=(child.props as any).children;
      // Void Markdown elements such as <br> cannot receive React children.
      // Passing even a wrapper whose own children are undefined crashes the
      // entire transcript with React error 137.
      if(nested==null)return child;
      return cloneElement(child as any,{},<MentionNodes children={nested} agents={agents} onOpenAgent={onOpenAgent}/>);
    }
    return child;
  });
}

function AgentText({text,agents,onOpenAgent}:{text:string;agents:Agent[];onOpenAgent:(id:string)=>void}) {
  return <ReactMarkdown components={{a:({href,children})=><a href={href} target="_blank" rel="noreferrer">{children}</a>,p:({children})=><p><MentionNodes children={children} agents={agents} onOpenAgent={onOpenAgent}/></p>,li:({children})=><li><MentionNodes children={children} agents={agents} onOpenAgent={onOpenAgent}/></li>}}>{text}</ReactMarkdown>;
}

function Attachments({items=[]}:{items?:Attachment[]}) { return items.length?<div className="message-attachments">{items.map(item=><button key={item.id} onClick={()=>window.open(`/api/workspace/file?path=${encodeURIComponent(item.path)}`,"_blank")}><Paperclip size={13}/><span>{item.name}</span><small>{Math.ceil(item.size/1024)} KB</small></button>)}</div>:null }

function Reactions({message,onReact,open}:{message:Message;onReact:(emoji:string)=>void;open:boolean}) { return <div className="reaction-wrap"><div className={`reaction-picker ${open?"open":""}`}>{["👍","❤️","😂","👀"].map(emoji=><button key={emoji} onClick={()=>onReact(emoji)}>{emoji}</button>)}</div>{Object.entries(message.reactions||{}).map(([emoji,users])=><button className="reaction" key={emoji} onClick={()=>onReact(emoji)}>{emoji} <span>{users.length}</span></button>)}</div> }

function MessageRow({room,message,agent,agents,allMessages,onReply,onReact,onOpenAgent}:{room?:Room;message:Message;agent?:Agent;agents:Agent[];allMessages:Message[];onReply:(m:Message)=>void;onReact:(emoji:string)=>void;onOpenAgent:(id:string)=>void}) {
  const [reacting,setReacting]=useState(false);
  const [actionsOpen,setActionsOpen]=useState(false);
  if(message.kind==="activity") return null;
  if(message.kind==="routine") return <div className="routine-event"><Clock3 size={14}/><span><strong>Routine started</strong>{message.content}</span></div>;
  if(room?.kind==="direct"&&message.kind==="peer-message"&&message.senderType==="agent"&&message.senderId!==room.directAgentId) return <details className="peer-exchange"><summary><span>Message from</span><button type="button" onClick={event=>{event.preventDefault();onOpenAgent(message.senderId)}}>{agent?.name||"Bot"}</button></summary><div className="peer-exchange-body"><AgentText text={message.content} agents={agents} onOpenAgent={onOpenAgent}/></div></details>;
  const replied = message.replyTo ? allMessages.find(item=>item.id===message.replyTo) : undefined;
  const replyPreview = replied&&<div className="reply-preview"><strong>{replied.senderType==="user"?"You":agents.find(a=>a.id===replied.senderId)?.name||"System"}</strong><span>{replied.content}</span></div>;
  const toggleActions=()=>setActionsOpen(value=>!value);
  if(message.senderType==="user") return <div className={`message-row user ${actionsOpen?"actions-open":""}`} onClick={toggleActions}><div className="message-actions" onClick={event=>event.stopPropagation()}><button type="button" title="React" onClick={()=>setReacting(value=>!value)}><SmilePlus size={16}/></button><button type="button" title="Reply" onClick={()=>onReply(message)}><MessageCircleReply size={16}/></button></div><div><div className="bubble">{replyPreview}<MentionText text={message.content} agents={agents} onOpenAgent={onOpenAgent}/><Attachments items={message.attachments}/></div><Reactions message={message} onReact={onReact} open={reacting}/></div></div>;
  return <div className={`message-row agent ${message.kind} ${message.status} ${actionsOpen?"actions-open":""}`} onClick={toggleActions}>
    {agent?<button type="button" className="avatar-button" title={`Open ${agent.name}'s chat`} onClick={event=>{event.stopPropagation();onOpenAgent(agent.id)}}><Avatar agent={agent}/></button>:<span className="avatar">!</span>}
    <div className="message-body"><div className="message-meta"><button type="button" onClick={event=>{event.stopPropagation();agent&&onOpenAgent(agent.id)}}>{agent?.name||"System"}</button><span>{agent?.title}</span>{message.status==="streaming"&&<LoaderCircle size={13} className="spin"/>}</div>{replyPreview}<div className="agent-copy"><AgentText text={message.content||"Thinking…"} agents={agents} onOpenAgent={onOpenAgent}/></div><Attachments items={message.attachments}/><Reactions message={message} onReact={onReact} open={reacting}/></div>
    <div className="message-actions" onClick={event=>event.stopPropagation()}><button type="button" title="React" onClick={()=>setReacting(value=>!value)}><SmilePlus size={16}/></button><button type="button" title="Reply" onClick={()=>onReply(message)}><MessageCircleReply size={16}/></button></div>
  </div>;
}

function ApprovalCard({approval,onDecision}:{approval:Approval;onDecision:(d:string)=>Promise<any>}) {
  return <div className="approval-card"><ShieldAlert size={20}/><div><strong>{approval.title}</strong><code>{approval.detail}</code><div><button onClick={()=>onDecision("decline")}>Decline</button><button className="primary" onClick={()=>onDecision("accept")}>Allow once</button></div></div></div>;
}

function AgentModal({agent,onClose,onSaved}:{agent:Agent|null;onClose:()=>void;onSaved:()=>void}) {
  const [form,setForm]=useState<any>(agent||{name:"",title:"",description:"",instructions:"",avatar:"",color:"#0A7A6B",avatarColor:"#0A7A6B",avatarAccent:"#D8F3EE",avatarShape:"blob",avatarFace:"dots",avatarTexture:"gradient",avatarMotion:"lively",avatarAccessory:"none",model:"gpt-5.6-terra",effort:"medium",networkAccess:true});
  const set=(key:string,value:any)=>setForm((f:any)=>({...f,[key]:value}));
  async function save(e:any){e.preventDefault();await request(agent?`/api/agents/${agent.id}`:"/api/agents",{method:agent?"PATCH":"POST",body:JSON.stringify(form)});onSaved()}
  async function remove(){if(!agent||!window.confirm(`Delete ${agent.name}? Its direct chat will be removed and its private workspace will be archived for recovery.`))return;await request(`/api/agents/${agent.id}`,{method:"DELETE"});onSaved()}
  function newFluidShape(){setForm((f:any)=>({...f,avatarShape:"custom",avatarVector:undefined,avatarShapeName:"Fluid",avatarMorph:Array.from({length:24},(_,index)=>Number((.82+Math.random()*.34+.07*Math.sin(index/24*Math.PI*6)).toFixed(3)))}))}
  return <Modal title={agent?"Bot settings":"Create new Bot"} onClose={onClose}><form onSubmit={save} className="form">
    <div className="profile-preview"><AvatarMark agent={{...form,id:form.id||form.name||"preview",name:form.name||"New Bot"}} large/><div><strong>{form.name||"New Bot"}</strong><span>{form.title||"Optional label"}</span></div></div>
    <label>Name<input required value={form.name} onChange={e=>set("name",e.target.value)} placeholder="e.g. Pixel"/></label>
    <label>Label <span className="optional">optional</span><input value={form.title} onChange={e=>set("title",e.target.value)} placeholder="Product designer, manager, researcher…"/></label>
    <label>Description<textarea value={form.description} onChange={e=>set("description",e.target.value)} placeholder="Who this Bot is and what it should know about its role"/></label>
    <label>Custom instructions<textarea className="tall" value={form.instructions} onChange={e=>set("instructions",e.target.value)} placeholder="Durable behavior, boundaries, and working style"/></label>
    <div className="form-grid"><label>Model<select value={form.model} onChange={e=>set("model",e.target.value)}><option>gpt-5.6-terra</option><option>gpt-5.6-luna</option><option>gpt-5.6-sol</option></select></label><label>Reasoning<select value={form.effort} onChange={e=>set("effort",e.target.value)}><option>low</option><option>medium</option><option>high</option><option>xhigh</option></select></label></div>
    <section className="appearance-card"><div><strong>Appearance</strong><small>Ask this Bot to change its look anytime, or make a quick adjustment here.</small></div><div className="appearance-actions"><button type="button" onClick={newFluidShape}>New fluid shape</button><label className="color-chip" title="Primary color"><input aria-label="Primary color" type="color" value={form.avatarColor||form.color} onChange={e=>setForm((f:any)=>({...f,color:e.target.value,avatarColor:e.target.value}))}/></label></div><details><summary>More appearance options</summary><div className="form-grid"><label>Character<select value={["cat","dog"].includes(form.avatarShape)?form.avatarShape:"fluid"} onChange={e=>e.target.value==="fluid"?newFluidShape():setForm((f:any)=>({...f,avatarShape:e.target.value,avatarMorph:undefined,avatarVector:undefined,avatarShapeName:""}))}><option value="fluid">Fluid</option><option value="cat">Cat</option><option value="dog">Dog</option></select></label><label>Motion<select value={form.avatarMotion||"lively"} onChange={e=>set("avatarMotion",e.target.value)}><option value="lively">Lively</option><option value="calm">Calm</option><option value="off">Still</option></select></label></div><div className="form-grid"><label>Face<select value={form.avatarFace||"dots"} onChange={e=>set("avatarFace",e.target.value)}><option value="dots">Dots</option><option value="visor">Visor</option><option value="spark">Spark</option><option value="none">None</option></select></label><label>Accessory<select value={form.avatarAccessory||"none"} onChange={e=>set("avatarAccessory",e.target.value)}><option value="none">None</option><option value="antenna">Antenna</option><option value="halo">Halo</option><option value="headphones">Headphones</option><option value="crown">Crown</option></select></label></div></details></section>
    <label className="capability-toggle"><input type="checkbox" checked={form.networkAccess!==false} onChange={e=>set("networkAccess",e.target.checked)}/><span><strong>Web and network access</strong><small>Allow this agent to research online and use networked developer tools.</small></span></label>
    <div className="form-actions">{agent&&<button className="delete-bot" type="button" onClick={remove}><Trash2 size={15}/>Delete Bot</button>}<button className="save" type="submit"><Check size={16}/>{agent?"Save Bot":"Create Bot"}</button></div>
  </form></Modal>;
}

function RoomModal({agents,room,onClose,onSaved,onDeleted}:{agents:Agent[];room:Room|null;onClose:()=>void;onSaved:(r:Room)=>void;onDeleted:()=>void}) {
  const [name,setName]=useState(room?.name||""); const [description,setDescription]=useState(room?.description||""); const [ids,setIds]=useState(room?.agentIds||agents.slice(0,4).map(a=>a.id));
  async function save(e:any){e.preventDefault();onSaved(await request(room?`/api/rooms/${room.id}`:"/api/rooms",{method:room?"PATCH":"POST",body:JSON.stringify({name,description,agentIds:ids})}))}
  async function remove(){if(!room||!window.confirm(`Delete ${room.name}? Its group transcript and routines will be removed. The Bots and their direct chats will stay.`))return;await request(`/api/rooms/${room.id}`,{method:"DELETE"});onDeleted()}
  return <Modal title={room?"Channel settings":"Create new Channel"} onClose={onClose}><form onSubmit={save} className="form"><label>Name<input required value={name} onChange={e=>setName(e.target.value)} placeholder="Product launch"/></label><label>Description and working contract<textarea className="tall" value={description} onChange={e=>setDescription(e.target.value)} placeholder="What this Channel is for and how its Bots should work together"/></label><span className="field-title">Add Bots · up to 6</span><div className="agent-picker">{agents.map(a=><button type="button" className={ids.includes(a.id)?"selected":""} key={a.id} onClick={()=>setIds(v=>v.includes(a.id)?v.filter(id=>id!==a.id):v.length<6?[...v,a.id]:v)}><Avatar agent={a}/><span><strong>{a.name}</strong><small>{a.title||"No label"}</small></span>{ids.includes(a.id)&&<Check size={16}/>}</button>)}</div><div className="form-actions">{room&&<button className="delete-bot" type="button" onClick={remove}><Trash2 size={15}/>Delete Channel</button>}<button className="save" disabled={!ids.length} type="submit"><Users size={16}/>{room?"Save Channel":"Create Channel"}</button></div></form></Modal>
}

function RoutineModal({room,agents,onClose,onSaved}:{room:Room;agents:Agent[];onClose:()=>void;onSaved:()=>void}) {
  const [name,setName]=useState(""); const [instruction,setInstruction]=useState(""); const [agentId,setAgentId]=useState(agents[0]?.id||""); const [intervalMinutes,setIntervalMinutes]=useState(1440);
  async function save(e:any){e.preventDefault();await request("/api/routines",{method:"POST",body:JSON.stringify({roomId:room.id,agentId,name,instruction,intervalMinutes,isEnabled:true})});onSaved()}
  return <Modal title="Create routine" onClose={onClose}><form onSubmit={save} className="form"><label>Name<input required value={name} onChange={e=>setName(e.target.value)} placeholder="Daily project check"/></label><label>Agent<select value={agentId} onChange={e=>setAgentId(e.target.value)}>{agents.map(agent=><option key={agent.id} value={agent.id}>{agent.name} · {agent.title}</option>)}</select></label><label>Instruction<textarea className="tall" required value={instruction} onChange={e=>setInstruction(e.target.value)} placeholder="What should this agent do each time?"/></label><label>When to run<select value={intervalMinutes} onChange={e=>setIntervalMinutes(Number(e.target.value))}><option value={60}>Every hour</option><option value={360}>Every 6 hours</option><option value={1440}>Every day</option><option value={10080}>Every week</option></select></label><button className="save" type="submit"><Clock3 size={16}/>Create routine</button></form></Modal>
}

function AgentDetails({agent,room,rooms,routines,onClose,onOpenWorkspace,onSettings,onCreateRoutine}:{agent:Agent;room:Room;rooms:Room[];routines:Routine[];onClose:()=>void;onOpenWorkspace:()=>void;onSettings:()=>void;onCreateRoutine:()=>void}) {
  const channels=rooms.filter(item=>item.kind==="group"&&item.agentIds.includes(agent.id));
  const activity=agent.awaitingUserResponse?"Waiting for you":agent.activity?.detail||agent.activity?.tool||(agent.status==="working"?"Working in the shared computer":"Computer ready");
  return <aside className="conversation-details agent-details">
    <header><div className="agent-details-title"><AvatarMark agent={agent} large/><div><div className="eyebrow">Bot</div><h2>{agent.name}</h2><p>{agent.title||"AI teammate"}</p></div></div><div className="detail-header-actions"><button type="button" onClick={onSettings} title={`Open ${agent.name} settings`}><Settings2 size={16}/></button><button type="button" onClick={onClose} title="Close info"><X size={17}/></button></div></header>
    <section className="agent-computer-section"><div className="details-heading"><h3>Computer</h3><span className={`computer-status ${agent.status==="working"?"active":""}`}>{agent.status==="working"?"Live":"Ready"}</span></div><button className="computer-preview" onClick={onOpenWorkspace}><span className="computer-preview-toolbar"><i/><i/><i/><small>Shared environment</small></span><span className="computer-preview-body"><Monitor size={24}/><strong>{activity}</strong><small>Open the shared computer and files</small></span></button></section>
    {agent.description&&<section><h3>About</h3><p className="channel-description">{agent.description}</p></section>}
    <section><div className="details-heading"><h3>Routines</h3><button onClick={onCreateRoutine}><Plus size={14}/>New</button></div>{routines.length?routines.map(routine=><div className="routine-card" key={routine.id}><div><strong>{routine.name}</strong><small>{routine.isEnabled?"Next run scheduled":"Paused"} · every {routine.intervalMinutes<1440?`${routine.intervalMinutes/60}h`:routine.intervalMinutes===1440?"day":`${routine.intervalMinutes/1440}d`}</small></div><button title="Run now" onClick={()=>request(`/api/routines/${routine.id}/run`,{method:"POST"})}><Play size={13}/></button><button className={`routine-toggle ${routine.isEnabled?"on":""}`} title={routine.isEnabled?"Disable":"Enable"} onClick={()=>request(`/api/routines/${routine.id}`,{method:"PATCH",body:JSON.stringify({isEnabled:!routine.isEnabled})})}><span/></button><button title="Delete routine" onClick={()=>window.confirm(`Delete ${routine.name}?`)&&request(`/api/routines/${routine.id}`,{method:"DELETE"})}><Trash2 size={13}/></button></div>):<div className="details-empty-card"><Clock3 size={18}/><p>No routines yet</p><span>Give {agent.name} recurring work that runs in a fresh session.</span><button onClick={onCreateRoutine}>Create routine</button></div>}</section>
    <section><h3>Channels</h3>{channels.length?<div className="channel-memberships">{channels.map(channel=><div key={channel.id}><span className="group-avatar small"><Users size={12}/></span><span><strong>{channel.name}</strong><small>{channel.description||`${channel.agentIds.length} Bots`}</small></span></div>)}</div>:<p className="details-empty">{agent.name} is not in any Channels yet.</p>}</section>
    <footer className="agent-details-footer"><span>Conversation</span><strong>{room.name}</strong><kbd>⌘⇧I</kbd></footer>
  </aside>;
}

function ConversationDetails({room,agents,routines,onClose,onSettings,onCreateRoutine,onOpenAgent}:{room:Room;agents:Agent[];routines:Routine[];onClose:()=>void;onSettings:()=>void;onCreateRoutine:()=>void;onOpenAgent:(id:string)=>void}) {
  const members=agents.filter(agent=>room.agentIds.includes(agent.id)); const available=agents.filter(agent=>!room.agentIds.includes(agent.id));
  async function setMembers(ids:string[]){if(!ids.length)return;await request(`/api/rooms/${room.id}`,{method:"PATCH",body:JSON.stringify({agentIds:ids})})}
  return <aside className="conversation-details"><header><div><div className="eyebrow">Channel</div><h2>{room.name}</h2></div><div className="detail-header-actions"><button onClick={onSettings} title="Channel settings"><Settings2 size={16}/></button><button onClick={onClose} title="Close info"><X size={17}/></button></div></header>{room.description&&<section><h3>Description</h3><p className="channel-description">{room.description}</p></section>}<section><h3>Members</h3>{members.map(agent=><div className="detail-agent" key={agent.id}><button onClick={()=>onOpenAgent(agent.id)}><Avatar agent={agent}/><span><strong>{agent.name}</strong><small>{agent.title||"No label"}</small></span></button><button disabled={members.length===1} title={`Remove ${agent.name}`} onClick={()=>setMembers(room.agentIds.filter(id=>id!==agent.id))}><X size={14}/></button></div>)}{available.length>0&&<div className="add-members"><span>Add a Bot</span>{available.map(agent=><button key={agent.id} disabled={room.agentIds.length>=6} onClick={()=>setMembers([...room.agentIds,agent.id])}><Plus size={13}/>{agent.name}</button>)}</div>}</section><section><div className="details-heading"><h3>Routines</h3><button onClick={onCreateRoutine}><Plus size={14}/>New</button></div>{routines.length?routines.map(routine=><div className="routine-card" key={routine.id}><div><strong>{routine.name}</strong><small>{agents.find(agent=>agent.id===routine.agentId)?.name} · every {routine.intervalMinutes<1440?`${routine.intervalMinutes/60}h`:routine.intervalMinutes===1440?"day":`${routine.intervalMinutes/1440}d`}</small></div><button title="Run now" onClick={()=>request(`/api/routines/${routine.id}/run`,{method:"POST"})}><Play size={13}/></button><button className={`routine-toggle ${routine.isEnabled?"on":""}`} title={routine.isEnabled?"Disable":"Enable"} onClick={()=>request(`/api/routines/${routine.id}`,{method:"PATCH",body:JSON.stringify({isEnabled:!routine.isEnabled})})}><span/></button><button title="Delete routine" onClick={()=>window.confirm(`Delete ${routine.name}?`)&&request(`/api/routines/${routine.id}`,{method:"DELETE"})}><Trash2 size={13}/></button></div>):<p className="details-empty">Recurring work for a Bot in this Channel.</p>}</section></aside>
}

function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:any}) {
  useEffect(()=>{
    const previous=document.body.style.overflow;
    document.body.style.overflow="hidden";
    return()=>{document.body.style.overflow=previous};
  },[]);
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}} role="presentation">
    <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="sheet-grabber" aria-hidden="true"><span/></div>
      <header><h2>{title}</h2><button type="button" onClick={onClose} aria-label="Close"><X size={20}/></button></header>
      {children}
    </div>
  </div>;
}

function WorkspacePanel({files,root,onClose,onRefresh}:{files:any[];root:string;onClose:()=>void;onRefresh:()=>void}) {
  const [preview,setPreview]=useState<{path:string;content:string}|null>(null);
  const [previewError,setPreviewError]=useState("");
  async function openFile(path:string){setPreviewError("");try{const response=await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`);if(!response.ok)throw new Error((await response.json()).error||"Could not open file");setPreview({path,content:await response.text()})}catch(e:any){setPreviewError(e.message)}}
  const render=(items:any[],level=0)=>items.map(item=><div key={item.path}><button className="file-row" style={{paddingLeft:12+level*15}} onClick={()=>item.type==="file"&&openFile(item.path)} disabled={item.type!=="file"}>{item.type==="directory"?<ChevronDown size={14}/>:<span className="file-dot"/>}<span>{item.name}</span>{item.size!=null&&<small>{Math.ceil(item.size/1024)} KB</small>}</button>{item.children&&render(item.children,level+1)}</div>);
  return <aside className="workspace-panel"><header><div><div className="eyebrow">Shared environment</div><h2>Workspace</h2></div><div><button onClick={onRefresh}><RefreshCw size={16}/></button><button onClick={onClose}><X size={17}/></button></div></header><p className="workspace-root">{root}</p>{preview?<div className="file-preview"><div><button onClick={()=>setPreview(null)}>← Files</button><strong>{preview.path}</strong></div><pre>{preview.content}</pre></div>:<div className="file-list">{previewError&&<div className="file-error">{previewError}</div>}{files.length?render(files):<div className="empty-files"><Files size={28}/><p>No shared files yet.</p><span>Files made by any agent appear here.</span></div>}</div>}</aside>
}
